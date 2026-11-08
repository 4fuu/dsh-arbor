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
 *    The pointer is recorded for the session that asked for it — see
 *    {@link addedDirectories} for which directory counts as asked for — so a
 *    session that never asked never has the line in its prompt.
 *
 * The registry is process-global, so this reflects arbor's projects for every
 * reader; DSH offers no per-session view of the workspace list (see
 * `docs/b3b-projects-and-sandbox.md`), so hiding arbor's projects from an
 * ordinary session's picker is not something this bridge can do. Ordinary
 * sessions keep their own cwd and sandbox on the embedded AgentLoop regardless —
 * this bridge never touches a session's own directory or its log.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import type { Workspace, WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'

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

/** One project of the shared folder: the one a session works in. */
export interface ExternalProject {
  /** The project folder's own name, the name the DSH project list shows. */
  readonly name: string
  /** The project's absolute path, a subfolder of the shared folder. */
  readonly path: string
}

/** What this bridge needs. */
export interface DshProjectBridgeOptions {
  /**
   * DSH's durable workspace registry, for a deployment that has one when this
   * bridge is built. A deployment whose registry activates later — the web
   * profile's activates after the arbor host — attaches it with
   * {@link DshProjectBridge.attach} instead; absent throughout leaves the bridge
   * inert.
   */
  readonly registry?: WorkspaceRegistry | undefined
  /** The arbor shared folder: the projects' home and ovnfs's source. */
  readonly sharedFolder: string
  /** Called with a non-fatal note, such as an adopt or sync failure. */
  readonly warn?: (message: string) => void
}

export class DshProjectBridge {
  private registry: WorkspaceRegistry | undefined
  private readonly sharedFolder: string
  private readonly warn: (message: string) => void
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined
  /**
   * Recorded external directories, per session: name -> absolute path. Never
   * projects. A session's set is what that session's `<workspace>` section
   * names, so a directory one session's user added is invisible to a session
   * that never asked for it.
   */
  private readonly pointers = new Map<SessionId, Map<string, string>>()
  /**
   * Canonical paths of directories the user added through DSH's own
   * add-workspace action, recorded by the {@link watchCreates} hook on the
   * registry. A pointer is recorded for an arbor session only when the session
   * names one of these: a directory the user deliberately added is a directory
   * the user means arbor to name, while a cwd a session merely inherited (DSH's
   * first-use default workspace, the most recent workspace) is not.
   */
  private readonly added = new Set<string>()

  constructor(options: DshProjectBridgeOptions) {
    this.registry = options.registry
    this.sharedFolder = resolve(options.sharedFolder)
    this.warn = options.warn ?? ((message: string) => console.warn(message))
  }

  /**
   * Attach DSH's durable workspace registry, register the shared folder's
   * projects in it, and keep the list live from then on. Returns a disposer.
   *
   * The registry is a web-profile service that activates after the arbor host
   * does, so a deployment cannot read it while the host is being built; this is
   * the seam that connects the two, the same one `@4fu/dsh-arbor-preset` uses
   * for the preset roster.
   */
  attach(registry: WorkspaceRegistry): () => void {
    this.registry = registry
    this.watchCreates(registry)
    void this.sync().catch((error: unknown) => {
      this.warn(`arbor projects: the first sync failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.start()
  }

  /**
   * Watch `WorkspaceRegistry.create` and remember every directory it registers
   * outside the shared folder.
   *
   * This is the seam that makes DSH's own add-workspace action record a pointer
   * for an arbor session with no new verb and no client change: the client's
   * add-workspace action calls the `workspace/create` remote verb
   * (`@deepseek-ai/dsh-api-workspace-controller`, `create`), which is the one
   * caller of `WorkspaceRegistry.create` in a DSH installation besides this
   * bridge's own {@link sync} — and `sync` only ever names project subfolders of
   * the shared folder, which the outside-shared-folder rule already excludes.
   * DSH's first-use default workspace is registered by
   * `WorkspaceRegistry.initializeDefault`, a different method that never reaches
   * `create`, so an inherited cwd is never mistaken for an added directory.
   *
   * The hook is a wrapper on the registry instance this bridge was handed,
   * restored never: the instance lives as long as the process, and the wrapper
   * delegates to the original for every call.
   */
  private watchCreates(registry: WorkspaceRegistry): void {
    const original = registry.create.bind(registry)
    const create = async (path: string, title?: string): Promise<Workspace> => {
      const workspace = await original(path, title)
      if (!this.insideSharedFolder(workspace.path)) this.added.add(workspace.path)
      return workspace
    }
    Object.defineProperty(registry, 'create', { value: create, configurable: true, writable: true })
  }

  /**
   * Every canonical path the user added through DSH's add-workspace action, in
   * add order. A directory is added once and stays added: it is a fact about
   * what the user put in the project list, not about the session that asked.
   */
  addedDirectories(): readonly string[] {
    return [...this.added]
  }

  /** Whether the user added this directory through DSH's add-workspace action. */
  isAddedDirectory(path: string): boolean {
    return this.added.has(resolve(path))
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
   * The project a directory names, or undefined when it names none.
   *
   * A project is a subfolder of the shared folder, which is the one place a
   * project lives: the shared folder itself is "no specific project yet", and a
   * directory outside it is not a project at all (it is a pointer, when the user
   * added it). The name is the folder's own, so the prompt, the DSH project list
   * and the checkout a window opens all name the same thing.
   */
  projectOf(path: string | undefined): ExternalProject | undefined {
    if (path === undefined) return undefined
    const absolute = resolve(path)
    if (absolute === this.sharedFolder) return undefined
    if (!this.insideSharedFolder(absolute)) return undefined
    const relative = absolute.slice(this.sharedFolder.length + 1)
    if (relative === '' || relative.includes(sep)) return undefined
    return { name: relative, path: absolute }
  }

  /**
   * Where one arbor session works: a project folder inside the shared folder.
   *
   * The shared folder itself (or nothing) is answered as-is — a session works in
   * the shared folder and opens a checkout of whichever project it needs, which
   * is what "an arbor session is not bound to one cwd" means. A path already
   * inside the shared folder is a project and is answered as-is. A directory
   * outside the shared folder is answered as the shared folder too: an arbor
   * session always works in arbor's own directory, and the shared folder is the
   * source of truth for what arbor checks out and applies, so an outside
   * directory is never a second project.
   *
   * Recording that outside directory as an {@link ExternalPointer} is NOT done
   * here. This runs for every arbor session, whatever directory its caller
   * happened to name, and a pointer is a deliberate record of a directory the
   * user means arbor to name — a session's requested cwd is not that. The
   * deliberate callers are {@link addPointer}: the driver, for a session that
   * became an arbor session while naming a directory the user had added through
   * DSH's own add-workspace action ({@link addedDirectories}), and the model.
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
   * Record an existing directory as an external pointer for one session: no
   * copy, no link, no adoption, and never a registered project. The caller that
   * means it — the driver, for a session that became an arbor session while
   * naming a directory the user added, or the model — names the directory and
   * the session it belongs to, and its name and absolute path are recorded so
   * arbor's prompt can name where the user's own files are; arbor's tools run
   * on the host, so the model reaches the path directly and a change there
   * lands on the user's files with no checkout and no apply. A second call for
   * the same name overwrites the path, so pointing a name at a new directory is
   * one edit.
   */
  addPointer(sessionId: SessionId, externalPath: string): ExternalPointer {
    const path = resolve(externalPath)
    const name = basename(path.replace(/\/+$/, '')) || 'project'
    const recorded = this.pointers.get(sessionId) ?? new Map<string, string>()
    recorded.set(name, path)
    this.pointers.set(sessionId, recorded)
    return { name, path }
  }

  /** Drop a pointer by name for one session; a no-op when the name is not recorded. */
  removePointer(sessionId: SessionId, name: string): void {
    const recorded = this.pointers.get(sessionId)
    if (recorded === undefined) return
    recorded.delete(name)
    if (recorded.size === 0) this.pointers.delete(sessionId)
  }

  /**
   * Every pointer one session recorded whose directory still exists, true at the
   * moment it is read: a pointer whose directory is gone is dropped here, so the
   * prompt never names a path that no longer exists. Sorted by name for a stable
   * line. An unknown session has none, which is the answer a window whose
   * session cannot be named gives — never another session's list.
   */
  async listPointers(sessionId: SessionId | undefined): Promise<readonly ExternalPointer[]> {
    const recorded = sessionId === undefined ? undefined : this.pointers.get(sessionId)
    if (recorded === undefined) return []
    const result: ExternalPointer[] = []
    for (const [name, path] of [...recorded]) {
      try {
        if ((await stat(path)).isDirectory()) result.push({ name, path })
      } catch {
        recorded.delete(name)
      }
    }
    if (recorded.size === 0 && sessionId !== undefined) this.pointers.delete(sessionId)
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * A revision that moves whenever any session's live pointer set moves, so a
   * running window's section is re-rendered — and handed a delta of only the
   * changed line — the moment the set changes. The host asks for it once per
   * step, so the existence check lives here: reading it drops a pointer whose
   * directory has gone, which moves the revision, which drops the line from the
   * prompt. It is a digest of every session's live set rather than a counter, so
   * a pointer removed and re-added at the same path costs nothing.
   */
  async pointerRevision(): Promise<string> {
    const parts: string[] = []
    for (const sessionId of [...this.pointers.keys()].sort()) {
      const listed = await this.listPointers(sessionId)
      if (listed.length === 0) continue
      parts.push(`${sessionId}:${listed.map(pointer => `${pointer.name}=${pointer.path}`).join('|')}`)
    }
    return parts.join(';')
  }

  /**
   * Make one arbor session a member of the workspace that owns the directory it
   * works in, registering that workspace when DSH's list has none.
   *
   * DSH answers "which workspace is this session in" from the workspace whose
   * member list names it, and filters a workspace's members by the session's
   * stored cwd (`@deepseek-ai/dsh-workspace`, `WorkspaceEntity.sessionIds` ->
   * `candidateMatches`), so an arbor session — whose cwd
   * {@link resolveProject} answers with arbor's own directory — is only a member
   * of a workspace whose path is that directory. Without this, a session the
   * driver created or re-routed under arbor belongs to no workspace at all, and
   * the hero composer answers `chipTitle === undefined` and renders inert
   * (`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`:
   * `inert = sessionId === void 0 || hero && chipTitle === void 0`) — the dead
   * composer the outside-directory add used to leave behind.
   *
   * The shared folder itself is registered the same way a project subfolder is:
   * `WorkspaceRegistry.create` reuses the record a canonical path already has,
   * so this is idempotent and never retitles an existing workspace.
   */
  async attachWorkspace(sessionId: SessionId, cwd: string): Promise<void> {
    if (this.registry === undefined) return
    try {
      const workspace = await this.registry.create(resolve(cwd), basename(resolve(cwd)))
      await workspace.attachSession(sessionId)
    } catch (error: unknown) {
      this.warn(`arbor projects: attaching session ${sessionId} to ${cwd} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
