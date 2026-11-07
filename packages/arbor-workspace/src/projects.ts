/**
 * The DSH project list, backed by arbor's shared folder.
 *
 * DSH models a project as a `Workspace` in its durable `WorkspaceRegistry`
 * (`ctx.workspaceRegistry`, `@deepseek-ai/dsh-workspace`): a stable id over a
 * canonical host directory, a title and an ordered session account. The web
 * client's project list, project picker and creation all read that registry, so
 * making arbor's projects appear there is what puts them in the UI — no client
 * patch is needed for the list itself.
 *
 * Arbor's decision, which reverses B3: for arbor sessions arbor takes over DSH's
 * project management, and a DSH project is a project subfolder of arbor's shared
 * folder (`DSH_HOME/arbor/shared`, ovnfs's source). This bridge keeps that true:
 *
 *  - {@link DshProjectBridge.sync} lists the shared folder's subfolders and
 *    registers each as a DSH `Workspace`, idempotently (the same canonical path
 *    reuses the existing record). It runs at host start and again whenever the
 *    shared folder changes, so a project a window creates with `mkdir` shows up
 *    without a restart.
 *  - {@link DshProjectBridge.resolveProject} answers where an arbor session
 *    works: a requested directory that is already inside the shared folder is a
 *    project; the shared folder itself means "no specific project yet"; and a
 *    directory outside the shared folder is **adopted** — copied once into a
 *    same-named project subfolder, the original left untouched — because ovnfs
 *    can only check out a subfolder of its source. That is the stated decision
 *    for how an existing DSH project with its own path joins the shared folder.
 *
 * The registry is process-global, so this reflects arbor's projects for every
 * reader; scoping the list to arbor sessions in the picker is a client concern
 * (the later UI stage). Ordinary sessions keep their own cwd and sandbox on the
 * embedded AgentLoop regardless — this bridge never touches a session's own
 * directory or its log.
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import type { Workspace, WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** One project as this bridge reports it. */
export interface DshProject {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
}

/** What this bridge needs. */
export interface DshProjectBridgeOptions {
  /** DSH's durable workspace registry. Absent leaves the bridge inert. */
  readonly registry: WorkspaceRegistry | undefined
  /** The arbor shared folder: the projects' home and ovnfs's source. */
  readonly sharedFolder: string
  /** Called with a non-fatal note, such as an adopt or sync failure. */
  readonly warn?: (message: string) => void
}

export class DshProjectBridge {
  private readonly registry: WorkspaceRegistry | undefined
  private readonly sharedFolder: string
  private readonly warn: (message: string) => void
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined

  constructor(options: DshProjectBridgeOptions) {
    this.registry = options.registry
    this.sharedFolder = resolve(options.sharedFolder)
    this.warn = options.warn ?? ((message: string) => console.warn(message))
  }

  /** Whether a requested directory already names the shared folder itself. */
  isSharedFolder(path: string): boolean {
    return resolve(path) === this.sharedFolder
  }

  /** Whether a requested directory already sits inside the shared folder. */
  insideSharedFolder(path: string): boolean {
    const absolute = resolve(path)
    return absolute === this.sharedFolder || absolute.startsWith(this.sharedFolder + sep)
  }

  /**
   * Where one arbor session works: a project folder inside the shared folder.
   *
   * The shared folder itself (or nothing) is answered as-is — a session works in
   * the shared folder and opens a checkout of whichever project it needs, which
   * is what "an arbor session is not bound to one cwd" means. A path already
   * inside the shared folder is a project and is answered as-is. A directory
   * outside the shared folder is **not** silently copied: the shared folder is
   * the source of truth, and an existing project joins it by explicit
   * {@link adopt}, never by a session being pointed at a copy of an arbitrary
   * directory the caller happened to name.
   */
  async resolveProject(requested: string | undefined): Promise<string> {
    if (requested === undefined || this.isSharedFolder(requested)) return this.sharedFolder
    if (this.insideSharedFolder(requested)) {
      await this.sync()
      return resolve(requested)
    }
    return this.sharedFolder
  }

  /**
   * Adopt an existing directory into the shared folder as a project, once.
   *
   * This is the explicit way an existing DSH project with its own path joins the
   * shared folder: a caller that means it — the UI's add-existing-project action,
   * or the model — names the directory, and it is copied to
   * `<shared>/<basename>`; an existing project folder of that name is reused
   * rather than overwritten, so adoption is idempotent and a second adoption
   * does not clobber the first's work. The original directory is never modified.
   * The copy is recursive and skips nothing the caller did not already have; a
   * `.git` directory travels with it, which is what lets a checkout get the
   * private git directory `apply --branch` needs.
   */
  async adopt(externalPath: string): Promise<string> {
    const name = basename(resolve(externalPath).replace(/\/+$/, '')) || 'project'
    const target = join(this.sharedFolder, name)
    try {
      await mkdir(target, { recursive: true })
      const existing = await readdir(target)
      if (existing.length === 0) {
        await cp(resolve(externalPath), target, { recursive: true })
      }
    } catch (error: unknown) {
      this.warn(`arbor projects: adopting ${externalPath} failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.sharedFolder
    }
    await this.sync()
    return target
  }

  /** Every project subfolder of the shared folder, registered in DSH's registry. */
  async sync(): Promise<readonly DshProject[]> {
    if (this.registry === undefined) return []
    let entries: string[]
    try {
      entries = await readdir(this.sharedFolder, { withFileTypes: true })
        .then(list => list.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name))
    } catch {
      return []
    }
    const projects: DshProject[] = []
    for (const name of entries.sort()) {
      const path = join(this.sharedFolder, name)
      try {
        if (!(await stat(path)).isDirectory()) continue
        const workspace = await this.registry.create(path, name)
        projects.push({ id: workspace.id, path: workspace.path, title: workspace.title })
      } catch (error: unknown) {
        this.warn(`arbor projects: registering ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return projects
  }

  /** The projects currently registered, as this bridge last synced the disk. */
  async list(): Promise<readonly DshProject[]> {
    return this.sync()
  }

  /**
   * Watch the shared folder and re-sync when a project appears or disappears, so
   * a project a window creates with `mkdir` reaches the DSH project list without
   * a restart. Returns a disposer.
   */
  start(): () => void {
    if (this.registry === undefined || this.watcher !== undefined) return () => {}
    try {
      this.watcher = watch(this.sharedFolder, () => {
        if (this.debounce !== undefined) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => { void this.sync().catch(() => {}) }, 100)
      })
    } catch (error: unknown) {
      this.warn(`arbor projects: watching ${this.sharedFolder} failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
    return () => this.stop()
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.debounce = undefined
    this.watcher?.close()
    this.watcher = undefined
  }
}
