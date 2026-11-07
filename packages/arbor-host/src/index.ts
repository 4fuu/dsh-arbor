/**
 * The one Arbor host a DSH process runs.
 *
 * Arbor's point is one journal, one note store and one board across many
 * sources, so a DSH process mounts exactly one `Arbor` host and every DSH user
 * session is one source (one conversation target) of it. This row owns that
 * host:
 *
 *  - the durable storage under `DSH_HOME/arbor/` — `@4fu/arbor-journal-sqlite`
 *    for the journal and `@4fu/arbor-notes-sqlite` for the note store, both on
 *    `node:sqlite`, so nothing native has to build and an arbor window survives
 *    a DSH restart (the host rebuilds every running window from the journal in
 *    `Arbor.start`);
 *  - the DSH-backed `AgentBackend` (`@4fu/dsh-arbor-llm`), which runs each
 *    window's turns through `ctx.llm` and each tool call through
 *    `ctx.tools.execute`;
 *  - the two prompt plugins (`@4fu/dsh-arbor-prompt`): a trusted `<harness>`
 *    section this bridge writes, and a `<dsh>` data block for third-party
 *    material;
 *  - the deployment's persona, read out of DSH's own assembly once and merged
 *    into arbor's `<identity>` section, because it is the deployment's
 *    configuration rather than a section of its own;
 *  - the environment (`@4fu/dsh-arbor-env`): arbor's own under
 *    `DSH_HOME/arbor/env`, with DSH's skills and MCP servers mounted read-only
 *    beside them;
 *  - the workspace (`@4fu/dsh-arbor-workspace`): arbor's own, over the shared
 *    folder under `DSH_HOME/arbor` — ovnfs when its daemon starts, the plain
 *    directory workspace otherwise. For arbor sessions there is no DSH sandbox:
 *    arbor's tools run on the host the way they do in standalone arbor, and the
 *    only protection is arbor's own secret scrub;
 *  - the project bridge (`@4fu/dsh-arbor-workspace`): the shared folder's
 *    project subfolders are registered in DSH's own `workspaceRegistry`, so
 *    arbor's projects are the DSH project list a user picks from;
 *  - the `send` executor (`./send.ts`): a window's `send` lands on the DSH
 *    session log as an assistant message, which is the only surface the user
 *    reads;
 *  - the settings, whose window block is left to arbor's own defaults: a window
 *    stays open 300 s after its run ends and the next input for the session
 *    opens the next window of its chain.
 *
 * The judge is off on purpose in B1: every judge decision is model-based, and
 * a model-based judge cannot run through the DSH backend yet. With the judge
 * off, `host.dispatch` is deterministic — one window per session target,
 * opened on the session's first turn — which is the routing policy B1 ships.
 *
 * There is no `workspaces.retentionMs` here: ovnfs checkouts are a window's own
 * work, and a chain that ends leaves them where they are until a retention
 * period is set, exactly as arbor's own defaults do. Nothing here is reclaimed
 * by default, and the shared folder's projects are never removed — they are the
 * user's work, not arbor's to delete.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Journal, NoteStore, Settings, Target, WindowRef } from '@4fu/arbor-interfaces'
import { MAX_PAGE_LIMIT } from '@4fu/arbor-interfaces'
import { Arbor } from '@4fu/arbor-core'
import { SqliteJournal } from '@4fu/arbor-journal-sqlite'
import { SqliteNoteStore } from '@4fu/arbor-notes-sqlite'
import { DirectoryEnvironment } from '@4fu/arbor-environment-dir'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { planProjectionDefinition } from '@deepseek-ai/dsh-plan-mode'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { createDshBackend, type DshBackend } from '@4fu/dsh-arbor-llm'
import {
  dshPromptPlugins,
  interpolatePersona,
  readDeploymentPersona,
  type DeploymentPersona,
  type HarnessState,
  type PersonaVariables,
} from '@4fu/dsh-arbor-prompt'
import { DshEnvironment, dshSkillSource } from '@4fu/dsh-arbor-env'
import { openArborWorkspace, DshProjectBridge, type DshProject } from '@4fu/dsh-arbor-workspace'
import type { WorkspaceBackend } from '@4fu/arbor-core'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { DshSendExecutor } from './send.ts'

export { DshSendExecutor, DSH_TARGET_PREFIX, DSH_USER_TARGET } from './send.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The one Arbor host this DSH process runs. */
    arborHost: ArborHostService
  }
}

/** Plugin config: the data root and extra arbor settings, merged over the defaults. */
export interface Config {
  /** Where the journal and the note store live. Defaults to `<DSH home>/arbor`. */
  readonly root?: string
  /** Extra arbor settings, merged over {@link defaultSettings}. */
  readonly settings?: Settings
}

/**
 * The settings this deployment runs arbor with.
 *
 * The identity is this bridge's own sentence, in Chinese like every other
 * model-facing line dsh-arbor writes, and it says only what is true and not
 * already said: `<harness>` states that the window runs inside DeepSeek
 * Harness and that the user sees only what `send` writes, and arbor's own
 * `<agent>` rules state that a window is disposable and that its chain
 * continues. Nothing here repeats either, and nothing here claims one DSH
 * session is one arbor window — several windows serve one source and each ends
 * on its own.
 *
 * `generalRules` is deliberately absent: arbor's own defaults are the seven
 * rules every window needs, in Chinese, and B0's English replacements dropped
 * them and restated two of them wrongly.
 *
 * The window block is deliberately absent too: arbor's own defaults apply
 * (300 s idle, 200 000 context tokens, 4 000 reserved), so a window that goes
 * quiet ends and the session's next turn opens the next window of its chain.
 *
 * The workspaces block is deliberately absent as well: the workspace is arbor's
 * own over the shared folder, ovnfs checkouts are a window's own work, and the
 * shared folder's projects are never reclaimed — so with no retention period
 * nothing is removed.
 */
export function defaultSettings(extra: Settings | undefined): Settings {
  return {
    identity: '你是 dsh-arbor 部署里的一个 arbor 窗口：DeepSeek Harness（DSH）是外壳，arbor 是里面的 agent 框架，你替 DSH 的用户干活。',
    judge: {
      modes: {
        filter: 'off',
        route: 'off',
        model_tier: 'off',
        notice: 'off',
        broadcast: 'off',
        active_set: 'off',
      },
    },
    ...extra,
  }
}

/** The target prefix that names the DSH session a window belongs to. */
export const SESSION_TARGET_PREFIX = 'dsh:session:'

/** The conversation target one DSH user session is, for arbor's dispatch. */
export function sessionTarget(sessionId: string): Target {
  return `${SESSION_TARGET_PREFIX}${sessionId}` as Target
}

/** The window a `window_start` continues, when it continues one. */
function continuedWindow(body: string | null): WindowRef | undefined {
  if (body === null) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    const previous = (parsed as { continuation?: unknown } | null)?.continuation
    return typeof previous === 'string' ? previous as WindowRef : undefined
  } catch {
    return undefined
  }
}

/** Everything the host owns, built once in `[Service.init]`. */
interface HostState {
  readonly root: string
  readonly journal: Journal
  readonly notes: NoteStore
  readonly backend: DshBackend
  readonly host: Arbor
  readonly settings: Settings
  /** The arbor shared folder: the projects' home and ovnfs's source. */
  readonly sharedFolder: string
  /** Which workspace backend arbor settled on, so the host can report it. */
  readonly workspaceBackend: WorkspaceBackend
  /** The DSH project bridge over the shared folder. */
  readonly projects: DshProjectBridge
}

/** The one Arbor host per DSH process, and the storage it runs on. */
export class ArborHostService extends Service {
  // What the host and the pieces it mounts read: the backend's LLM and tools,
  // the registry that names the session whose turn is running, DSH's prompt
  // assembly and DSH's skill registry for `/env`. The workspace is arbor's own
  // (ovnfs or the plain directory over the shared folder), so it needs neither
  // DSH's filesystem/shell seams nor the sandbox policy — those stay mounted for
  // ordinary sessions on the embedded AgentLoop, and arbor's windows simply do
  // not route through them.
  static inject = [
    'llm', 'tools', 'agents', 'systemPrompt', 'sessionProjections', 'skills',
  ]

  static Config: z<Config, Config> = z.object({}) as unknown as z<Config, Config>

  readonly config: Config

  private state: HostState | undefined
  /** Raised whenever a DSH prompt provider changes, so both sections follow. */
  private promptChanges = 0
  /** Plan mode's projection, so the `<harness>` section can read it per step. */
  private planProjection: ProjectionHandle<{ active: boolean }> | undefined
  /** The deployment's persona, read once when the host is built. */
  private persona: DeploymentPersona | undefined
  /** The last provider and model a live session rendered under, for the fallback. */
  private lastProvider: string | undefined
  private lastModel: string | undefined
  /** The warnings the bridge raised while the host was built, for diagnostics. */
  readonly warnings: string[] = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'arborHost')
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const root = this.config.root ?? join(resolveDshHome(), 'arbor')
    await mkdir(root, { recursive: true })
    const journal = new SqliteJournal({ path: join(root, 'journal.sqlite') })
    const notes = new SqliteNoteStore({ path: join(root, 'notes.sqlite'), journal })
    // The deployment's persona belongs in arbor's <identity>, so it is read out
    // of DSH's own assembly before the host is built. A persona a plugin
    // registers after this point is not carried; the section it registers is
    // still decided by the table and reported through `warnings`.
    const persona = await readDeploymentPersona(ctx.systemPrompt)
    this.persona = persona
    for (const warning of persona.warnings) {
      this.warnings.push(warning)
      ctx.logger.warn(warning)
    }
    const settings = defaultSettings(this.config.settings)
    // `identity` is a getter rather than a string because DSH's persona carries
    // `{{model}}` and `{{provider}}`, which are per-request values there: the
    // loop re-resolves them on every request, and arbor's prefix is frozen per
    // epoch, so the only faithful resolution is the one for the session whose
    // turn is rendering. Arbor reads `settings.identity` at each render
    // (`renderSystemPrompt`), so the getter is evaluated per epoch.
    const identity = settings.identity ?? ''
    Object.defineProperty(settings, 'identity', {
      enumerable: true,
      configurable: true,
      get: () => [identity, ...this.personaLines()].filter(part => part !== '').join('\n\n'),
    })
    // The backend is built before the host, because the host is built with it;
    // the renderer is therefore read lazily, and only once a delivery has to be
    // rendered — which is long after the host exists.
    let host: Arbor | undefined
    const backend = createDshBackend({
      llm: ctx.llm,
      tools: ctx.tools,
      // One backend serves every session's windows, so the agent a tool call
      // runs as is resolved per call: the session whose turn is executing it,
      // which is the initiating agent of that turn (see @4fu/dsh-arbor-tools).
      agents: ctx.agents,
      renderer: () => {
        if (host === undefined) throw new Error('arbor host: the renderer was read before the host existed')
        return host.renderer
      },
    })
    // Arbor's own workspace over the shared folder: ovnfs when its daemon
    // starts, the plain-directory workspace otherwise. For arbor sessions there
    // is no DSH sandbox — arbor's file tools run on the host the way they do in
    // standalone arbor, and arbor's own secret scrub is the only protection on
    // what reaches the model. The `<workspace>` section and the `workspace.*`
    // module functions are the backend's own, with no sandbox line and no
    // `sandbox_escalate`.
    const arborWorkspace = await openArborWorkspace({
      root,
      journal,
      warn: message => ctx.logger.warn(message),
    })
    // The DSH project bridge: the shared folder's project subfolders become the
    // DSH project list. `workspaceRegistry` is a web-profile service, so it is
    // read lazily and the bridge stays inert on a profile that has none
    // (headless, acp, sdk), which never renders a project picker.
    const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
    const projects = new DshProjectBridge({
      registry,
      sharedFolder: arborWorkspace.sharedFolder,
      warn: message => ctx.logger.warn(message),
    })
    // `/env`: arbor's own environment under DSH_HOME/arbor, with DSH's skills
    // and MCP servers mounted read-only beside it.
    const environment = new DshEnvironment({
      inner: new DirectoryEnvironment({ root, supervisor: undefined }),
      skills: dshSkillSource(ctx.skills, listener => ctx.on('skills/change', listener)),
      toolNames: () => ctx.tools.definitions().map(tool => tool.name),
      cwd: () => ctx.agents.currentInitiator()?.session.header.cwd ?? arborWorkspace.sharedFolder,
      seedSettings: settings,
    })
    host = new Arbor({
      journal,
      notes,
      backend,
      workspace: arborWorkspace.workspace,
      environment,
      plugins: dshPromptPlugins({
        systemPrompt: ctx.systemPrompt,
        // The assembly runs in the scope of the session whose turn is rendering
        // the section, which is what lets DSH's own `plan:policy` say whether
        // plan mode is active. Arbor rebuilds an epoch whenever a section's
        // revision moves, and the revision covers this session's state, so two
        // sessions of different states never share one epoch.
        agent: () => ctx.agents.currentInitiator(),
        // A fresh signal per assembly: a section is re-rendered by the host's
        // own watch loop, after the turn that opened the window has ended, and
        // DSH's working-directory context provider does filesystem I/O under
        // this signal — a finished turn's would abort it.
        signal: new AbortController().signal,
        changeCounter: () => this.promptChanges,
        state: () => this.harnessState(),
        onWarning: (message) => {
          this.warnings.push(message)
          ctx.logger.warn(message)
        },
      }),
      settings,
      executors: [new DshSendExecutor({ journal, agents: ctx.agents })],
    })
    this.state = {
      root,
      journal,
      notes,
      backend,
      host,
      settings,
      sharedFolder: arborWorkspace.sharedFolder,
      workspaceBackend: arborWorkspace.backend,
      projects,
    }
    // Plan mode's projection is registered here rather than only in the plan
    // row, because the <harness> section reads it once per step. Registration
    // is refcounted per key, so both see one fold of the same session log.
    this.planProjection = await ctx.sessionProjections.register(planProjectionDefinition)
    // Register the shared folder's projects in DSH's registry and keep the list
    // live, so a project a window creates reaches the UI without a restart. The
    // disposer runs on unload.
    await projects.sync()
    const stopProjects = projects.start()
    // Rebuild every window the journal still holds open: a window a previous
    // process stopped is continued here, the way the hard limit continues one.
    await host.start()
    // Every DSH prompt-provider change moves the `<dsh>` section's revision, so
    // arbor re-renders it and hands the changed lines to live windows.
    ctx.on('system-prompt/change', () => { this.promptChanges += 1 })
    ctx.effect(() => async () => {
      stopProjects()
      // Stopping the host records `host_restart` for every live window, so the
      // next start continues each of them; the stores close after it.
      await host.close().catch(() => {})
      await journal.close().catch(() => {})
      await notes.close().catch(() => {})
    }, 'arborHost.close()')
  }

  /**
   * The dynamic state the `<harness>` section renders, read for the session
   * whose turn is running.
   *
   * A section is frozen per epoch and shared by every window of it, so a
   * session's own policy is the one whose turn is rendering — the same rule
   * arbor's `<workspace>` section follows for its root. A window a restart
   * continued renders outside any turn and therefore without these lines until
   * its session's next turn moves the revision and delivers them as a delta.
   */
  private harnessState(): HarnessState {
    const ctx = this.ctx
    const agent = ctx.agents.currentInitiator()
    const session = agent?.session
    // The approval policy: the session's own override when it has one, else the
    // deployment's configured default. `effectivePolicy` is DSH-private, and
    // `overrideOf` plus the config is the public half of the same read.
    const approvalService = ctx.get('approval')
    const approval = session === undefined
      ? undefined
      : approvalService?.overrideOf(session) ?? approvalService?.config.policy
    const planActive = session === undefined ? false : this.planReader(session).active === true
    return {
      approval,
      planActive,
      exposedTools: this.state?.backend.externalToolNames() ?? [],
    }
  }

  /** The plan-mode state of one session, from the host's own registration. */
  private planReader(session: Session): { active: boolean } {
    const handle = this.planProjection
    if (handle === undefined) return { active: false }
    return handle.readerFor(session)()
  }

  /**
   * Note that a DSH prompt input changed without a `system-prompt/change`.
   *
   * The driver calls this after it installs the arbor tool restriction in a
   * session's scope: a `tool:*` section's text reads whether its tool is
   * registered, and the restriction moves that without a registration change.
   */
  noteDshPromptChange(): void {
    this.promptChanges += 1
  }

  /**
   * The deployment's persona lines, with DSH's prompt variables resolved
   * against the session whose turn is rendering.
   *
   * A window a restart continued renders outside any turn, so the last values
   * a live session gave are the fallback: the persona then names the model that
   * session was running rather than carrying a placeholder.
   */
  private personaLines(): string[] {
    const agent = this.ctx.agents.currentInitiator()
    const selection = agent?.model.current()
    const provider = selection?.provider ?? agent?.options.provider
    const model = selection?.model ?? agent?.options.model
    if (provider !== undefined) this.lastProvider = provider
    if (model !== undefined) this.lastModel = model
    const resolved: PersonaVariables = {
      ...this.lastProvider === undefined ? {} : { provider: this.lastProvider },
      ...this.lastModel === undefined ? {} : { model: this.lastModel },
    }
    return [this.persona?.prefix ?? '', this.persona?.suffix ?? '']
      .map(text => interpolatePersona(text, resolved))
      .filter(text => text !== '')
  }

  private requireState(): HostState {
    if (this.state === undefined) {
      throw new Error('arbor host is not started (the @4fu/dsh-arbor-host row has not activated)')
    }
    return this.state
  }

  /** The one Arbor host of this process. */
  get host(): Arbor {
    return this.requireState().host
  }

  /** The durable journal every window of this process records into. */
  get journal(): Journal {
    return this.requireState().journal
  }

  /** The durable note store beside the journal. */
  get notes(): NoteStore {
    return this.requireState().notes
  }

  /** The settings this host runs arbor with. */
  get settings(): Settings {
    return this.requireState().settings
  }

  /** The arbor shared folder: the projects' home and ovnfs's source. */
  get sharedFolder(): string {
    return this.requireState().sharedFolder
  }

  /** Which workspace backend arbor settled on: `ovnfs` or `dir`. */
  get workspaceBackend(): WorkspaceBackend {
    return this.requireState().workspaceBackend
  }

  /** The DSH project bridge over the shared folder. */
  get projects(): DshProjectBridge {
    return this.requireState().projects
  }

  /**
   * Where one arbor session works: a project folder inside the shared folder.
   *
   * The driver calls this for an arbor session's requested cwd and sets the
   * session's cwd to the answer, so the DSH session, its cwd display and the
   * project picker all agree on the shared folder. A directory outside the
   * shared folder is not copied; it joins the shared folder only through
   * {@link adoptArborProject}.
   */
  resolveArborCwd(requested: string | undefined): Promise<string> {
    return this.requireState().projects.resolveProject(requested)
  }

  /**
   * Adopt an existing directory into the shared folder as a project, once. The
   * explicit way an existing DSH project with its own path joins the shared
   * folder; the UI's add-existing-project action or the model calls it.
   */
  adoptArborProject(path: string): Promise<string> {
    return this.requireState().projects.adopt(path)
  }

  /** Every project registered from the shared folder, as DSH lists them. */
  listArborProjects(): Promise<readonly DshProject[]> {
    return this.requireState().projects.list()
  }

  /** The backend every window of this process runs through. */
  get backend(): DshBackend {
    return this.requireState().backend
  }

  /** The directory the journal and the note store live in. */
  get dataRoot(): string {
    return this.requireState().root
  }

  /**
   * Every window of this session's chain, oldest first.
   *
   * The chain is the session's first window, its continuations, and the one a
   * restart opened for it. The first window carries the session's target, and
   * every window after it names its predecessor in its own `window_start` body
   * — which is what makes the chain walkable: a restart continuation carries no
   * targets of its own, so the target alone does not name the newest window.
   * The relay reads the chain's tool calls back out of the journal on resume.
   */
  async windowChainOf(sessionId: SessionId): Promise<WindowRef[]> {
    const target = sessionTarget(sessionId)
    const { journal } = this.requireState()
    const continued = new Map<WindowRef, WindowRef>()
    let newest: WindowRef | undefined
    for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
      const page = await journal.list({ kinds: ['window_start'], limit: MAX_PAGE_LIMIT, offset })
      for (const event of page.items) {
        if (event.window === null) continue
        if (event.targets.includes(target)) newest = event.window
        const previous = continuedWindow(event.body)
        if (previous !== undefined) continued.set(previous, event.window)
      }
      if (page.items.length < MAX_PAGE_LIMIT) break
    }
    const chain: WindowRef[] = []
    let current = newest
    while (current !== undefined && chain.length < 1000) {
      chain.push(current)
      current = continued.get(current)
    }
    return chain
  }

  /**
   * The window this session's work is running in, when it has a live one.
   *
   * The journal is the record of which window belongs to which session: every
   * `window_start` carries the session's target, a continuation carries its
   * predecessor's, and a window a restart stopped is continued under a new ref
   * with the same target. So the newest `window_start` for the target names the
   * session's window, and it is the live one unless the chain has ended.
   */
  async windowFor(sessionId: SessionId): Promise<WindowRef | undefined> {
    const { host } = this.requireState()
    const newest = (await this.windowChainOf(sessionId)).at(-1)
    if (newest === undefined) return undefined
    return host.live().some(record => record.window === newest && record.state !== 'ended')
      ? newest
      : undefined
  }
}

export default ArborHostService
