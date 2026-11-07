/**
 * The arbor workspace of a DSH session: the session's cwd is the root.
 *
 * Arbor's own default workspace keeps every window's directory under one root
 * the host names at construction. A DSH process serves many sessions, each
 * with its own working directory, so the root cannot be one path: this
 * multiplexer keeps one `DirectoryWorkspace` per session cwd and routes every
 * window-keyed call to the one that session's windows belong to. The session a
 * window belongs to is in the journal — every `window_start` carries the
 * session's target — so the routing survives a restart, and the cwd each
 * session runs in is noted by the driver when the session is created or
 * resumed.
 *
 * A window's own directory is `<cwd>/ws<N>`, where `N` is the window's number
 * in the one journal, so a ref names the same directory whichever session it
 * came from and the ref-to-root routing below never collides.
 *
 * The `<workspace>` prompt section is host-level, and arbor renders one prefix
 * per epoch shared by every window opened in it. The section therefore names
 * the cwd of the session whose turn is opening the window, resolved when the
 * section is rendered: the window that opens sees its own root, and the
 * section carries no revision, so a window that is already running is never
 * told another session's root mid-turn. With several sessions of different
 * cwds in one process, a window opened inside an epoch built for another
 * session carries that session's root in its frozen prefix and its own in the
 * first input's delta. B3's own workspace implementation — one over DSH's
 * sandboxed filesystem — replaces this module and renders the section per
 * session.
 */

import type {
  Journal,
  PromptSection,
  TextTable,
  ToolGroup,
  WindowRef,
  Workspace,
  WorkspaceKeep,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from '@4fu/arbor-interfaces'
import {
  DIRECTORY_METHOD_BLOCK,
  DirectoryWorkspace,
  WorkspaceDirGroup,
  directoryText,
} from '@4fu/arbor-workspace-dir'

/** The target prefix that names the DSH session a window belongs to. */
const SESSION_TARGET_PREFIX = 'dsh:session:'

/** The workspace arbor's own directory implementation gives, per session cwd. */
export class DshSessionWorkspace implements Workspace {
  private readonly roots = new Map<string, DirectoryWorkspace>()
  /** Which root a workspace ref lives under, learned when the ref was created. */
  private readonly refRoots = new Map<WorkspaceRef, string>()
  /** The root the last session to run noted, for a render outside any turn. */
  private lastRoot: string | undefined

  private readonly journal: Journal
  private readonly cwdOf: (sessionId: string) => string | undefined
  private readonly currentSession: () => string | undefined

  constructor(options: {
    journal: Journal
    /** The cwd one DSH session runs in, as the driver noted it. */
    cwdOf: (sessionId: string) => string | undefined
    /** The session whose turn is running, when one is. */
    currentSession: () => string | undefined
  }) {
    this.journal = options.journal
    this.cwdOf = options.cwdOf
    this.currentSession = options.currentSession
  }

  /** The DSH session one window belongs to, from the journal's own record. */
  private async sessionOfWindow(window: WindowRef): Promise<string | undefined> {
    const page = await this.journal.list({ window, kinds: ['window_start'], limit: 1 })
    const target = page.items[0]?.targets.find(one => one.startsWith(SESSION_TARGET_PREFIX))
    return target?.slice(SESSION_TARGET_PREFIX.length)
  }

  /** The root one window's session works in. */
  private async rootOfWindow(window: WindowRef): Promise<string> {
    const session = await this.sessionOfWindow(window)
    const root = session === undefined ? undefined : this.cwdOf(session)
    return root ?? this.lastRoot ?? process.cwd()
  }

  /** The root a workspace ref lives under, as its creating window resolved it. */
  private rootOfRef(ref: WorkspaceRef, fallback: () => Promise<string>): Promise<string> {
    const known = this.refRoots.get(ref)
    return Promise.resolve(known ?? fallback())
  }

  /** The directory workspace for one root, created on first use. */
  private workspaceFor(root: string): DirectoryWorkspace {
    const existing = this.roots.get(root)
    if (existing !== undefined) return existing
    const created = new DirectoryWorkspace({ root, journal: this.journal })
    this.roots.set(root, created)
    return created
  }

  async create(window: WindowRef): Promise<WorkspaceRef> {
    const root = await this.rootOfWindow(window)
    this.lastRoot = root
    const ref = await this.workspaceFor(root).create(window)
    this.refRoots.set(ref, root)
    return ref
  }

  async mount(ref: WorkspaceRef): Promise<WorkspaceMount> {
    const root = await this.rootOfRef(ref, async () => this.currentRoot())
    return this.workspaceFor(root).mount(ref)
  }

  async quota(workspace: WorkspaceRef): Promise<WorkspaceQuota> {
    const root = await this.rootOfRef(workspace, async () => this.currentRoot())
    return this.workspaceFor(root).quota(workspace)
  }

  async reclaim(workspace: WorkspaceRef): Promise<void> {
    const root = await this.rootOfRef(workspace, async () => this.currentRoot())
    await this.workspaceFor(root).reclaim(workspace)
  }

  async refOf(window: WindowRef): Promise<WorkspaceRef | undefined> {
    const root = await this.rootOfWindow(window)
    const ref = await this.workspaceFor(root).refOf(window)
    if (ref !== undefined) this.refRoots.set(ref, root)
    return ref
  }

  /** The directory a window works in, for the file tools. */
  async pathOfWindow(window: WindowRef): Promise<string | undefined> {
    const ref = await this.refOf(window)
    if (ref === undefined) return undefined
    const root = this.refRoots.get(ref) ?? await this.rootOfWindow(window)
    return this.workspaceFor(root).pathOf(ref)
  }

  /** The persistent directory `name` names, under the window's session root. */
  async keep(window: WindowRef, name: string): Promise<string> {
    const root = await this.rootOfWindow(window)
    return this.workspaceFor(root).keep(window, name)
  }

  /** The persistent directories on disk, or only one window's chain's. */
  async keeps(window?: WindowRef): Promise<readonly WorkspaceKeep[]> {
    if (window === undefined) {
      const seen = new Map<string, WorkspaceKeep>()
      for (const root of [...this.roots.keys(), this.currentRoot()]) {
        for (const keep of await this.workspaceFor(root).keeps()) {
          seen.set(keep.name, keep)
        }
      }
      return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name))
    }
    const root = await this.rootOfWindow(window)
    return this.workspaceFor(root).keeps(window)
  }

  /**
   * What this implementation adds to the catalog, routed through this object.
   *
   * The declarations are arbor's own — the plain-directory workspace's group
   * declares them — and only the calls are routed: a call names the window it
   * comes from, so it runs in the workspace of that window's session. The
   * group itself is constructed per root, which is what keeps its paths right
   * whatever the group calls on the workspace later.
   */
  groups(table: TextTable): readonly ToolGroup[] {
    // The group's declarations name no path — only its calls do — so the
    // instance they are read from is irrelevant and the calls never reach it.
    const declaring = new WorkspaceDirGroup(this.workspaceFor(this.currentRoot()), table)
    return [{
      id: declaring.id,
      tools: () => declaring.tools(),
      modules: () => declaring.modules(),
      call: async (request, context) => (await this.groupFor(context.window, table)).call(request, context),
    }]
  }

  /** The plain-directory workspace group for one window's session root. */
  private async groupFor(window: WindowRef, table: TextTable): Promise<WorkspaceDirGroup> {
    return new WorkspaceDirGroup(this.workspaceFor(await this.rootOfWindow(window)), table)
  }

  /** This implementation's prompt section, naming the root of the session opening. */
  promptSection(): PromptSection {
    return {
      tag: 'workspace',
      blocks: [DIRECTORY_METHOD_BLOCK],
      text: directoryText,
      content: () => [{ kind: 'directory_method', fields: { root: this.currentRoot() } }],
    }
  }

  /** The root the session whose turn is running works in. */
  private currentRoot(): string {
    const session = this.currentSession()
    const root = session === undefined ? undefined : this.cwdOf(session)
    return root ?? this.lastRoot ?? process.cwd()
  }
}
