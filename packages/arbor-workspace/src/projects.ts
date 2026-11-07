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
 *    directory outside the shared folder is answered as the shared folder too —
 *    an arbor session always works in arbor's own directory, and the outside
 *    directory is recorded as a {@link ExternalPointer} (name and absolute path)
 *    rather than copied, linked or adopted, because the owner's decision is no
 *    copy: arbor's tools run on the host, so the model can work in the user's
 *    own directory directly, and the pointer line in arbor's prompt says so.
 *
 * The registry is process-global, so this reflects arbor's projects for every
 * reader; scoping the list to arbor sessions in the picker is a client concern
 * (the later UI stage). Ordinary sessions keep their own cwd and sandbox on the
 * embedded AgentLoop regardless — this bridge never touches a session's own
 * directory or its log.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import type { Workspace, WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** One project as this bridge reports it. */
export interface DshProject {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
}

/**
 * One external directory recorded as a pointer.
 *
 * The owner's decision for an existing DSH project with its own path is no copy,
 * no mount and no adoption: the session goes to arbor's own directory (the
 * shared folder) and the user's original directory is recorded as a pointer, so
 * arbor's prompt can name it and the model can work in it directly (arbor's
 * tools run on the host, so the absolute path is reachable). A pointer is never
 * registered as a project arbor works in — it is a fact in the prompt, not a
 * checkout.
 */
export interface ExternalPointer {
  /** The directory's basename, the name the prompt shows. */
  readonly name: string
  /** The absolute path the prompt names, where the user's own files are. */
  readonly path: string
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
  /** Recorded external directories: name -> absolute path. Never projects. */
  private readonly pointers = new Map<string, string>()

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
   * outside the shared folder is answered as the shared folder too: an arbor
   * session always works in arbor's own directory, and the outside directory is
   * recorded as a pointer (see {@link addPointer}) rather than copied — the
   * shared folder is the source of truth for what arbor checks out and applies,
   * and a pointer is a fact in the prompt, never a second project.
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
   * Record an existing directory as an external pointer: no copy, no link, no
   * adoption, and never a registered project. The caller that means it — the
   * UI's add-workspace action, or the model — names the directory, and its name
   * and absolute path are recorded so arbor's prompt can name where the user's
   * own files are; arbor's tools run on the host, so the model reaches the path
   * directly and a change there lands on the user's files with no checkout and
   * no apply. A second call for the same name overwrites the path, so pointing
   * a name at a new directory is one edit.
   */
  addPointer(externalPath: string): ExternalPointer {
    const path = resolve(externalPath)
    const name = basename(path.replace(/\/+$/, '')) || 'project'
    this.pointers.set(name, path)
    return { name, path }
  }

  /** Drop a pointer by name; a no-op when the name is not recorded. */
  removePointer(name: string): void {
    this.pointers.delete(name)
  }

  /**
   * Every recorded pointer whose directory still exists, true at the moment it
   * is read: a pointer whose directory is gone is dropped here, so the prompt
   * never names a path that no longer exists. Sorted by name for a stable line.
   */
  async listPointers(): Promise<readonly ExternalPointer[]> {
    const result: ExternalPointer[] = []
    for (const [name, path] of [...this.pointers]) {
      try {
        if ((await stat(path)).isDirectory()) result.push({ name, path })
      } catch {
        this.pointers.delete(name)
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * A revision that moves whenever the live pointer set moves, so a running
   * window's section is re-rendered — and handed a delta of only the changed
   * line — the moment the set changes. The host asks for it once per step, so
   * the existence check lives here: reading it drops a pointer whose directory
   * has gone, which moves the revision, which drops the line from the prompt.
   * It is a digest of the live set rather than a counter, so a pointer removed
   * and re-added at the same path costs nothing.
   */
  async pointerRevision(): Promise<string> {
    const live = await this.listPointers()
    return live.map(pointer => `${pointer.name}=${pointer.path}`).join('|')
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
