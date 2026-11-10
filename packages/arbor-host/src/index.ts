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
 *  - the settings, whose window block keeps a window open for 24 hours after
 *    its run ends (`window.idleSeconds: 86400`) and leaves the rest to arbor's
 *    defaults; the session's next turn then continues in the same window, with
 *    its prefix and context intact, instead of opening a continuation;
 *  - the API keys arbor reads. Their values are DSH's, stored in its credential
 *    store and never in a configuration; this row mirrors a stored value into
 *    the process environment, which is where arbor's judge, its secret scrub
 *    and every child process resolve a secret by name.
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type { Environment, Journal, NoteStore, Plugin, Settings, Target, WindowRef, Workspace } from '@4fu/arbor-interfaces'
import { MAX_PAGE_LIMIT } from '@4fu/arbor-interfaces'
import { Arbor } from '@4fu/arbor-core'
import { SqliteJournal } from '@4fu/arbor-journal-sqlite'
import { SqliteNoteStore } from '@4fu/arbor-notes-sqlite'
import { DirectoryEnvironment } from '@4fu/arbor-environment-dir'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { planProjectionDefinition } from '@deepseek-ai/dsh-plan-mode'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
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
import { DshEnvironment, dshSkillSource, type WindowLimits } from '@4fu/dsh-arbor-env'
import { openArborWorkspace, arborSharedFolder, DshProjectBridge, type DshProject, type ExternalPointer, type ExternalProject } from '@4fu/dsh-arbor-workspace'
import type { WorkspaceBackend } from '@4fu/arbor-core'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { DshSendExecutor } from './send.ts'

export { DshSendExecutor, DSH_TARGET_PREFIX, DSH_USER_TARGET } from './send.ts'

/** Arbor's own default context budget, used when DSH reports no model capacity. */
export const DEFAULT_CONTEXT_TOKENS = 200_000

/** Arbor's own default reserve, used when a model's capacity is unknown. */
export const DEFAULT_RESERVE_TOKENS = 4_000

/**
 * The share of a model's context window held back for the final reminder: two
 * percent, capped at arbor's own 4k default. A smaller window gets a smaller
 * reserve so the reminder still leaves room for a handoff; a larger window needs
 * no more than 4k for the same job.
 */
export function reserveTokensFor(contextTokens: number): number {
  return Math.min(DEFAULT_RESERVE_TOKENS, Math.max(1, Math.floor(contextTokens / 50)))
}

/** A budget resolved from one model: both numbers are known. */
interface ModelWindow {
  readonly contextTokens: number
  readonly reserveTokens: number
}

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
 * What a user may change from the Arbor page, as one patch.
 *
 * These are the settings arbor reads while it runs: the judge decisions, the
 * limits a new window opens with, the active-note budget, and how long a
 * chain's checkout is kept. Facts arbor settles at startup — the workspace
 * backend, the shared folder, the model catalog the tier mapping resolves
 * against — are not here: changing one would not move the host that is already
 * running, and a control that changes nothing is worse than a fact that says so.
 */
export interface SettingsUpdate {
  /** One mode per judge decision; omitted decisions keep their setting. */
  readonly judgeModes?: Readonly<Record<string, string>>
  readonly window?: {
    readonly idleSeconds?: number
    readonly contextTokens?: number
    readonly reserveTokens?: number
    readonly protectionSeconds?: number
    readonly handoffFloor?: number
  }
  readonly notes?: {
    readonly activeCount?: number
    readonly activeTokenBudget?: number
  }
  /** How long a chain's checkout is kept after its last window ended; 0 keeps it. */
  readonly retentionMs?: number
}

/** The judge decisions arbor's settings name. */
const JUDGE_DECISIONS = new Set(['filter', 'route', 'model_tier', 'notice', 'broadcast', 'active_set'])

/** The three modes a judge decision can be in. */
const JUDGE_MODES = new Set(['off', 'shadow', 'on'])

/**
 * The environment variable arbor's default judge reads its key from.
 *
 * The judge is Jev (`@4fu/arbor-judge-jev`), which resolves `JEV_API_KEY` per
 * request, so a key set while DSH runs reaches the very next decision. The name
 * is restated here rather than imported: `@4fu/arbor-core` depends on the judge
 * package and re-exports neither the name nor the judge, and dsh-arbor's own
 * settings name the secret the same way a deployment would.
 */
export const JUDGE_KEY = 'JEV_API_KEY'

/**
 * One API key arbor reads, as the settings page may show and change it.
 *
 * A key is a name and never a value: the value lives in DSH's credential store
 * (`$DSH_HOME/.credentials.yaml` through `ctx.credentials` on the web and
 * desktop profiles), which is the same store DSH's own Models page writes, and
 * what crosses the wire is only whether one is set, which layer supplies it and
 * whether this deployment can change it.
 */
export interface ArborKeyFacts {
  /** The name arbor resolves it by, such as `JEV_API_KEY`. */
  readonly name: string
  /** What reads it: arbor's default judge, or a name arbor's settings declare. */
  readonly purpose: 'judge' | 'secret'
  /** Whether resolving it right now returns a value. */
  readonly set: boolean
  /** The layer supplying the value (`file`, `env`, `project-env`, `user-env`). */
  readonly source?: string
  /** Whether this deployment has a credential store to write it to. */
  readonly writable: boolean
}

/** One key's name and what reads it. */
interface KeyName {
  readonly name: string
  readonly purpose: 'judge' | 'secret'
}

/**
 * The credential layer DSH's local provider stores values in.
 *
 * `describe` reports which layer supplies a reference; `file` is the managed
 * document this page writes, as opposed to the launch environment and the two
 * `.env` layers the provider falls back to.
 */
const STORED_LAYER = 'file'

/** A name as a credential reference, or undefined when its grammar refuses it. */
function refOf(name: string): CredentialRef | undefined {
  try {
    return credentialRef(name)
  } catch {
    return undefined
  }
}


/** One integer setting in range, or a refusal naming it. */
function checkedInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** One numeric setting in range, or a refusal naming it. A fraction is not an integer. */
function checkedNumber(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

/**
 * The settings this deployment runs arbor with.
 *
 * The identity is this bridge's own sentence, in Chinese like every other
 * model-facing line dsh-arbor writes, and it says only what is true and not
 * already said: `<harness>` states that the window runs inside DeepSeek
 * Harness, and arbor's own `<agent>` rules state that a finished round leaves
 * the window idle and that its chain continues. Nothing here repeats either,
 * and nothing here claims one DSH session is one arbor window — several windows
 * serve one source and each ends on its own.
 *
 * `generalRules` is deliberately absent: arbor's own defaults are the seven
 * rules every window needs, in Chinese, and B0's English replacements dropped
 * them and restated two of them wrongly.
 *
 * The window block keeps a window open for 24 hours after its run ends
 * (`window.idleSeconds: 86400`), so a session's next turn continues in the
 * same window with its prefix and context intact. The context limit and reserve
 * are not seeded: {@link ArborHostService.limitsForWindow} writes the selected
 * model's real context window and the reserve derived from it before each
 * window opens, and arbor's 200 000/4 000 defaults apply when DSH reports no
 * capacity. A deployment that names its own window values overrides either.
 *
 * The workspaces block is deliberately absent as well: the workspace is arbor's
 * own over the shared folder, ovnfs checkouts are a window's own work, and the
 * shared folder's projects are never reclaimed — so with no retention period
 * nothing is removed.
 */
export function defaultSettings(extra: Settings | undefined): Settings {
  return {
    identity: '你替 DeepSeek Harness（DSH）的用户完成会话里的任务。',
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
    window: { idleSeconds: 86_400, ...extra?.window },
  }
}

/** The target prefix that names the DSH session a window belongs to. */
export const SESSION_TARGET_PREFIX = 'dsh:session:'

/** The conversation target one DSH user session is, for arbor's dispatch. */
export function sessionTarget(sessionId: string): Target {
  return `${SESSION_TARGET_PREFIX}${sessionId}` as Target
}

/** The DSH session a conversation target names, or undefined for any other target. */
export function sessionOfTarget(target: Target): SessionId | undefined {
  return target.startsWith(SESSION_TARGET_PREFIX)
    ? target.slice(SESSION_TARGET_PREFIX.length) as SessionId
    : undefined
}

/**
 * The plugin that records which DSH session each window serves.
 *
 * Arbor's `windowStart` hook runs before the `window_start` event is appended
 * and before the window's prompt epoch is rendered, and it carries the window
 * ref together with the task's targets — the only moment at which a window can
 * be attributed to a session before its prefix is built. A prompt section that
 * answers per session (the external-project pointers, the project line) is
 * rendered for a window, and a window's prefix is frozen when it opens, so the
 * attribution has to exist by then: reading it later would put those lines in a
 * delta of the window's opening instead of in the prefix it opens with.
 *
 * The `windowContinue` hook is the same moment for a continuation window, which
 * carries no targets of its own — a continuation continues its predecessor's
 * work, so it serves the session that window served. Without it a window the
 * host continues (the hard limit, an idle handover, a restart's recovery) opens
 * with a prefix that names no session and loses both per-session lines.
 *
 * The hooks observe and change nothing about the window's prompt; a window they
 * cannot attribute — one dispatched from outside a DSH session — opens exactly
 * as it would without them. The one thing they set is the window budget: the
 * limit and reserve a model's real context window implies, computed before the
 * host records the window (see {@link ArborHostService.limitsForWindow}).
 *
 * @param note - called with the window and the session it serves.
 * @param sessionOf - the session a window already recorded serves, for a
 *   continuation to inherit.
 * @param limits - called with the window and the session it serves, before the
 *   window's record and prompt are built.
 */
export function windowSessionPlugin(
  note: (window: WindowRef, sessionId: SessionId) => void,
  sessionOf: (window: WindowRef) => SessionId | undefined,
  limits?: (window: WindowRef, sessionId: SessionId | undefined) => Promise<void> | void,
): Plugin {
  return {
    name: 'dsh-arbor-window-session',
    hooks: {
      windowStart: async (context) => {
        const label = context.task.label
        let served: SessionId | undefined
        if (label !== undefined && label !== '') {
          served = label as SessionId
          note(context.window, served)
        } else {
          // An unlabeled task from an SDK or a remote integration still carries
          // its session target; the label is the deployment's own attachment.
          for (const target of context.task.targets) {
            const sessionId = sessionOfTarget(target)
            if (sessionId !== undefined) {
              served = sessionId
              note(context.window, sessionId)
            }
          }
        }
        await limits?.(context.window, served)
        return { allow: true as const, context }
      },
      windowContinue: async (context) => {
        const inherited = sessionOf(context.previous)
        if (inherited !== undefined) note(context.window, inherited)
        await limits?.(context.window, inherited)
        return { allow: true as const, context }
      },
    },
  }
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

/** The opaque label a `window_start` carries, or the empty string. */
function readLabel(event: { body: string | null }): string {
  if (event.body === null) return ''
  try {
    const parsed: unknown = JSON.parse(event.body)
    const label = (parsed as { label?: unknown } | null)?.label
    return typeof label === 'string' ? label : ''
  } catch {
    return ''
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
  /** Arbor's own workspace over the shared folder. */
  readonly workspace: Workspace
  /** The environment every window reads at `/env`. */
  readonly environment: Environment
  /** The arbor shared folder: the projects' home and ovnfs's source. */
  readonly sharedFolder: string
  /** Which workspace backend arbor settled on, so the host can report it. */
  readonly workspaceBackend: WorkspaceBackend
  /** The DSH project bridge over the shared folder. */
  readonly projects: DshProjectBridge
  /** The send executor, so the driver can flush its messages after a step's results. */
  readonly sendExecutor: DshSendExecutor
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
  /**
   * Which DSH session each window serves, written by the `windowStart` hook
   * before the window's prefix is built. Arbor's own `WindowRef` carries no
   * session identity, and a per-session prompt section is rendered for a window,
   * so this is the mapping that section reads.
   */
  private readonly windowSessions = new Map<WindowRef, SessionId>()
  /**
   * The stored cwd of a session whose agent is not live, read once. A session's
   * stored header never moves, so the answer is remembered; the live projection
   * takes over the moment the session is back.
   */
  private readonly storedCwds = new Map<SessionId, string | undefined>()
  /** Raised whenever a DSH prompt provider changes, so both sections follow. */
  private promptChanges = 0
  /** Plan mode's projection, so the `<harness>` section can read it per step. */
  private planProjection: ProjectionHandle<{ active: boolean }> | undefined
  /** The deployment's persona, read once when the host is built. */
  private persona: DeploymentPersona | undefined
  /** The last provider and model a live session rendered under, for the fallback. */
  private lastProvider: string | undefined
  private lastModel: string | undefined
  /**
   * The window budget the next window records: the selected model's context
   * window and the reserve derived from it. Empty means arbor's own defaults.
   * Read through the settings getter {@link DshEnvironment} installs.
   */
  private windowBudget: WindowLimits = {}
  /** Which windows got a model budget and which fell back to arbor's default. */
  private readonly windowLimitSources = new Map<WindowRef, 'model' | 'default'>()
  /** The budget each window keeps, so the backend's usage follows its own model. */
  private readonly windowBudgets = new Map<WindowRef, ModelWindow>()
  /** The source of the last window budget, for the settings facts. */
  private lastWindowLimitSource: 'model' | 'default' | undefined
  /** The context window resolved per DSH route, `undefined` when it gave none. */
  private readonly modelWindows = new Map<string, ModelWindow | undefined>()
  /** Resolutions in flight, so one window does not ask twice for one route. */
  private readonly modelWindowsPending = new Map<string, Promise<ModelWindow | undefined>>()
  /** The warnings the bridge raised while the host was built, for diagnostics. */
  readonly warnings: string[] = []
  /**
   * What each key's environment variable held before this host mirrored a
   * stored value into it, so clearing a key restores the launcher's value
   * rather than removing it.
   */
  private readonly ambientKeys = new Map<string, string | undefined>()

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
      // The budget this window's session resolved, so a window's own usage
      // keeps its model's limit even while another session opens beside it.
      limitsOf: window => this.windowBudgets.get(window),
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
    // `sandbox_escalate`; the external-project pointers are rendered inside that
    // same section, so "where you work" and "where the user's own directories
    // are" are answered in one place.
    // The DSH project bridge: the shared folder's project subfolders become the
    // DSH project list. `workspaceRegistry` is a web-profile service, and it
    // activates AFTER this host does — DSH's own activation order is
    // service-availability driven and this host declares no dependency on it —
    // so it is injected rather than read: on a deployment with no registry
    // (headless, acp, sdk) the child never activates and the bridge stays inert,
    // and on the web profile it attaches the registry and keeps the list live.
    // Reading it once here instead left the bridge permanently inert on the web
    // profile, which is why arbor's projects never reached the picker.
    const projects = new DshProjectBridge({
      sharedFolder: arborSharedFolder(root),
      warn: message => ctx.logger.warn(message),
    })
    this.ctx.inject(['workspaceRegistry'], (child) => {
      child.effect(() => projects.attach(child.get('workspaceRegistry') as WorkspaceRegistry),
        'arborHost.projects()')
    })
    const arborWorkspace = await openArborWorkspace({
      root,
      journal,
      warn: message => ctx.logger.warn(message),
      pointers: {
        // The section is rendered for one window, and the window names the
        // session whose pointers it answers with. The attribution is the
        // `windowStart` hook's, which runs before the window's prefix is built,
        // so the pointer is in the prefix the window opens with rather than in a
        // delta of its own opening. A window nothing attributes (one dispatched
        // from outside a DSH session) names no session, and an unnamed session
        // has no pointers rather than another session's.
        list: (window) => projects.listPointers(window === undefined ? undefined : this.sessionOfWindow(window)),
        // The project the session was opened on, read from the session's own cwd
        // through the window that serves it: the project is a fact about where
        // the user pointed the session, and the cwd is where the driver resolved
        // that to.
        project: (window) => this.projectOfWindow(window),
        revision: () => this.workspaceRevision(),
      },
    })
    // `/env`: arbor's own environment under DSH_HOME/arbor, with DSH's skills
    // and MCP servers mounted read-only beside it.
    const environment = new DshEnvironment({
      inner: new DirectoryEnvironment({ root, supervisor: undefined }),
      skills: dshSkillSource(ctx.skills, listener => ctx.on('skills/change', listener)),
      toolNames: () => ctx.tools.definitions().map(tool => tool.name),
      cwd: () => ctx.agents.currentInitiator()?.session.header.cwd ?? arborWorkspace.sharedFolder,
      seedSettings: settings,
      // The selected model's real context window, read when a window opens.
      // The environment's settings getter puts it under `window`, so arbor's
      // record, reminders and `<board>` use one limit per window.
      windowLimits: () => this.windowBudget,
    })
    const sendExecutor = new DshSendExecutor({ journal, agents: ctx.agents })
    host = new Arbor({
      journal,
      notes,
      backend,
      workspace: arborWorkspace.workspace,
      environment,
      plugins: [
        ...dshPromptPlugins({
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
        windowSessionPlugin(
          (window, sessionId) => { this.windowSessions.set(window, sessionId) },
          (window) => this.windowSessions.get(window),
          (window, sessionId) => this.limitsForWindow(window, sessionId),
        ),
      ],
      settings,
      executors: [sendExecutor],
    })
    this.state = {
      root,
      journal,
      notes,
      backend,
      host,
      settings,
      workspace: arborWorkspace.workspace,
      environment,
      sharedFolder: arborWorkspace.sharedFolder,
      workspaceBackend: arborWorkspace.backend,
      projects,
      sendExecutor,
    }
    // Plan mode's projection is registered here rather than only in the plan
    // row, because the <harness> section reads it once per step. Registration
    // is refcounted per key, so both see one fold of the same session log.
    this.planProjection = await ctx.sessionProjections.register(planProjectionDefinition)
    // Register the shared folder's projects in DSH's registry and keep the list
    // live, so a project a window creates reaches the UI without a restart. With
    // no registry attached yet — the web profile's activates after this host —
    // both are no-ops here and the injected child above does them instead.
    await projects.sync()
    projects.start()
    // Which session every recorded window serves, rebuilt from the journal
    // before the host starts: the recovery below continues every window the
    // journal still holds open, a continuation carries no targets of its own, and
    // the map the hooks would have written died with the process that wrote it.
    // Reading it here is what keeps the per-session prompt lines — the project
    // line and the pointers — in the prefix a recovered window opens with.
    await this.rebuildWindowSessions()
    // Rebuild every window the journal still holds open: a window a previous
    // process stopped is continued here, the way the hard limit continues one.
    await host.start()
    // Every DSH prompt-provider change moves the `<dsh>` section's revision, so
    // arbor re-renders it and hands the changed lines to live windows.
    ctx.on('system-prompt/change', () => { this.promptChanges += 1 })
    // DSH's credential store is a row of the web and desktop profiles and is
    // disabled on the headless one, so it may appear after this host does. When
    // it is there, the keys arbor reads take their values from it (and follow
    // every later change); when it is not, the settings page reports them
    // read-only rather than offering a control that writes nowhere.
    this.ctx.inject(['credentials'], (child) => {
      void this.adoptCredentials(child).catch((error: unknown) => {
        ctx.logger.warn(`arbor: could not adopt DSH's credentials: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    ctx.effect(() => async () => {
      projects.stop()
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

  /**
   * Fill the next window's budget from the model the session is about to use.
   *
   * The hook runs before arbor records the window and before its prompt epoch
   * is built, so arbor's `usage`, the board, the usage reminders and the hard
   * limit all read one limit for the window's own model. A session whose model
   * DSH cannot describe, or a window dispatched outside any DSH session, leaves
   * the budget empty and arbor's 200k/4k defaults apply; the facts record that
   * as `limitSource: 'default'`.
   *
   * The budget is also kept per window: arbor passes `limits` to the backend
   * later, after another session may have moved the shared value, and the
   * backend's own usage must still follow the window it belongs to.
   */
  async limitsForWindow(window: WindowRef, sessionId: SessionId | undefined): Promise<void> {
    const selection = this.selectionOf(sessionId)
    const limits = selection === undefined ? undefined : await this.budgetForSelection(selection)
    if (limits === undefined) {
      this.windowBudget = {}
      this.windowBudgets.delete(window)
      this.windowLimitSources.set(window, 'default')
      this.lastWindowLimitSource = 'default'
      return
    }
    this.windowBudget = limits
    this.windowBudgets.set(window, limits)
    this.windowLimitSources.set(window, 'model')
    this.lastWindowLimitSource = 'model'
  }

  /** Whether a window's budget came from its model or from arbor's default. */
  windowLimitSourceOf(window: WindowRef): 'model' | 'default' | undefined {
    return this.windowLimitSources.get(window)
  }

  /** The source of the most recently opened window's budget, for settings facts. */
  currentWindowLimitSource(): 'model' | 'default' | undefined {
    return this.lastWindowLimitSource
  }

  /**
   * The model a session's next step uses: its own recorded selection, its live
   * options, or DSH's default route. A recovered window opens before its
   * session resumes and has no live agent, so it answers no selection and takes
   * arbor's default budget rather than another session's route.
   */
  private selectionOf(sessionId: SessionId | undefined): Readonly<ModelSelection> | undefined {
    if (sessionId !== undefined) {
      const agent = this.ctx.agents.get(sessionId)
      // A recovered window opens before its session resumes. Reading the
      // process default there would name another model, so the window takes
      // arbor's default budget and the facts say so.
      if (agent === undefined) return undefined
      const selected = agent.model.current()
      if (selected !== undefined) return selected
      const options = agent.options
      if (options.provider !== undefined && options.model !== undefined) {
        return {
          provider: options.provider,
          model: options.model,
          ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        }
      }
    }
    const defaults = this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
    return defaults?.currentSelection()
  }

  /** One model's budget, resolved once per route for the process's lifetime. */
  private async budgetForSelection(selection: Readonly<ModelSelection>): Promise<ModelWindow | undefined> {
    const key = `${selection.provider}\u0000${selection.model}`
    if (this.modelWindows.has(key)) return this.modelWindows.get(key)
    let pending = this.modelWindowsPending.get(key)
    if (pending === undefined) {
      pending = this.resolveWindow(selection)
      this.modelWindowsPending.set(key, pending)
    }
    try {
      const limits = await pending
      this.modelWindows.set(key, limits)
      return limits
    } finally {
      this.modelWindowsPending.delete(key)
    }
  }

  /** DSH's answer for one exact route, or `undefined` when it gives none. */
  private async resolveWindow(selection: Readonly<ModelSelection>): Promise<ModelWindow | undefined> {
    const route = `${selection.provider}/${selection.model}`
    try {
      const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)
      const contextTokens = info.context?.contextWindow
      if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens) || contextTokens <= 0) {
        this.ctx.logger.warn(`dsh-arbor: DSH reports no context window for ${route}; arbor's ${DEFAULT_CONTEXT_TOKENS}-token default is used`)
        return undefined
      }
      return { contextTokens: Math.floor(contextTokens), reserveTokens: reserveTokensFor(contextTokens) }
    } catch (error: unknown) {
      this.ctx.logger.warn(`dsh-arbor: could not read the context window for ${route}: ${error instanceof Error ? error.message : String(error)}; arbor's ${DEFAULT_CONTEXT_TOKENS}-token default is used`)
      return undefined
    }
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

  /**
   * Install a user's settings change as arbor's own settings item.
   *
   * The settings live at `/env/settings.json` like every other environment
   * item, so the change goes through the environment's own install path: it is
   * parsed and validated as a whole, lands as one environment revision, and is
   * refused without changing anything. The host then re-reads the environment,
   * which is the same `refresh` its own `reload` performs, so the values arbor
   * reads while it dispatches — judge modes, window limits, note budget,
   * retention — are the installed ones. No restart is involved.
   *
   * Only the fields a person can safely change are accepted; everything else
   * in the installed document is carried over from the settings currently in
   * force, so a judge threshold or a model tier the deployment set is never
   * dropped by a change from this page.
   *
   * @param update - the settings the page lets a user change.
   * @returns the settings now in force, as the environment holds them.
   * @throws when a value is out of range or the environment refuses the install.
   */
  async updateSettings(update: SettingsUpdate): Promise<Settings> {
    const state = this.requireState()
    const current: Settings = await state.environment.settings() ?? state.settings
    const modes: Record<string, string> = { ...current.judge?.modes }
    for (const [decision, mode] of Object.entries(update.judgeModes ?? {})) {
      if (!JUDGE_DECISIONS.has(decision)) throw new Error(`unknown judge decision ${JSON.stringify(decision)}`)
      if (!JUDGE_MODES.has(mode)) throw new Error(`judge decision ${JSON.stringify(decision)} must be off, shadow or on`)
      modes[decision] = mode
    }
    const window = { ...current.window }
    if (update.window?.idleSeconds !== undefined) window.idleSeconds = checkedInteger('window.idleSeconds', update.window.idleSeconds, 0, 86_400)
    if (update.window?.contextTokens !== undefined) window.contextTokens = checkedInteger('window.contextTokens', update.window.contextTokens, 1_000, 2_000_000)
    if (update.window?.reserveTokens !== undefined) window.reserveTokens = checkedInteger('window.reserveTokens', update.window.reserveTokens, 0, 1_000_000)
    if (update.window?.protectionSeconds !== undefined) window.protectionSeconds = checkedInteger('window.protectionSeconds', update.window.protectionSeconds, 0, 3_600)
    if (update.window?.handoffFloor !== undefined) window.handoffFloor = checkedNumber('window.handoffFloor', update.window.handoffFloor, 0, 1)
    if (window.contextTokens !== undefined && window.reserveTokens !== undefined && window.reserveTokens >= window.contextTokens) {
      throw new Error('window.reserveTokens must be smaller than window.contextTokens')
    }
    const notes = { ...current.notes }
    if (update.notes?.activeCount !== undefined) notes.activeCount = checkedInteger('notes.activeCount', update.notes.activeCount, 1, 1_000)
    if (update.notes?.activeTokenBudget !== undefined) notes.activeTokenBudget = checkedInteger('notes.activeTokenBudget', update.notes.activeTokenBudget, 100, 1_000_000)
    const workspaces = { ...current.workspaces }
    if (update.retentionMs !== undefined) workspaces.retentionMs = checkedInteger('workspaces.retentionMs', update.retentionMs, 0, 31_536_000_000)
    const next: Settings = {
      ...current,
      judge: { ...current.judge, modes },
      window,
      notes,
      workspaces,
    }
    const draft = await mkdtemp(join(tmpdir(), 'dsh-arbor-settings-'))
    try {
      const file = join(draft, 'settings.json')
      await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      // A settings draft is the JSON file itself: the environment installs a
      // file at `env/settings.json`, while a directory draft would be copied
      // as a directory and the settings read would find no file.
      await state.environment.install([{ kind: 'settings', name: 'settings', path: file }])
    } finally {
      await rm(draft, { recursive: true, force: true }).catch(() => undefined)
    }
    await (state.host as unknown as { refresh(): Promise<void> }).refresh()
    return await state.environment.settings() ?? next
  }

  /**
   * The API keys arbor reads, in the order the settings page lists them: the
   * judge's own key, then every secret name arbor's settings declare.
   *
   * A key is a name and nothing more. The value lives in DSH's credential store,
   * which is where DSH's Models page writes too, and this answer carries only
   * what a configuration surface may show: whether a value is behind the name,
   * which layer supplies it, and whether this deployment can write it.
   *
   * @returns one fact per key arbor reads.
   */
  async keys(): Promise<readonly ArborKeyFacts[]> {
    const credentials = this.credentials()
    const facts: ArborKeyFacts[] = []
    for (const key of await this.keyNames()) {
      const ref = refOf(key.name)
      const value = await this.keyValue(key.name)
      const info = ref === undefined || credentials === undefined ? undefined : await credentials.describe(ref)
      facts.push({
        name: key.name,
        purpose: key.purpose,
        set: value !== undefined,
        ...(value === undefined || info?.source === undefined ? {} : { source: info.source }),
        writable: info?.writable === true,
      })
    }
    return facts
  }

  /**
   * Store one key's value in DSH's credential store, where a configuration never
   * holds it, and publish it where arbor resolves it.
   *
   * The value is written and then forgotten: nothing here returns it, logs it or
   * puts it in a settings document. The store keeps it for the next process, and
   * this process's environment carries it so arbor's own resolution — the
   * judge's per-request `JEV_API_KEY` read and the host's secret scrub — sees it
   * from the next decision on.
   *
   * @param name - one of the names {@link keys} reports.
   * @param value - the non-empty key to store.
   * @returns the keys as they stand after the write.
   * @throws when the name is not one arbor reads, the value is empty, or this
   *   deployment has no credential store.
   */
  async setKey(name: string, value: string): Promise<readonly ArborKeyFacts[]> {
    if (value === '') throw new Error('a key must not be empty; clear it instead')
    const ref = await this.keyRef(name)
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new Error('this deployment has no credential store, so a key cannot be saved here')
    }
    await credentials.set(ref, value)
    await this.publishKey(name)
    return this.keys()
  }

  /**
   * Remove one key's stored value; a value supplied by the launch environment
   * takes over again, which is what {@link keys} then reports.
   *
   * @param name - one of the names {@link keys} reports.
   * @returns the keys as they stand after the removal.
   * @throws when the name is not one arbor reads, or this deployment has no
   *   credential store.
   */
  async clearKey(name: string): Promise<readonly ArborKeyFacts[]> {
    const ref = await this.keyRef(name)
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new Error('this deployment has no credential store, so a key cannot be cleared here')
    }
    await credentials.unset(ref)
    await this.publishKey(name)
    return this.keys()
  }

  /**
   * Put the value arbor resolves for one name into this process's environment,
   * which is where arbor reads a secret, and let the host re-read its secrets.
   *
   * `Arbor` resolves every configured secret through `process.env` by default,
   * and the judge reads its key from there per decision, so the environment is
   * the one place a value saved through the settings page has to reach. The
   * refresh after it is what re-reads the scrub, so the new value is hidden from
   * the model and the journal from the next event on; a child process started
   * afterwards inherits it.
   *
   * The value before this host mirrored anything is kept, so clearing a stored
   * key uncovers the one the process launched with instead of dropping it.
   */
  private async publishKey(name: string): Promise<void> {
    if (!this.ambientKeys.has(name)) this.ambientKeys.set(name, process.env[name])
    const stored = await this.storedKey(name)
    const value = stored ?? this.ambientKeys.get(name)
    if (value === undefined || value === '') delete process.env[name]
    else process.env[name] = value
    await (this.requireState().host as unknown as { refresh(): Promise<void> }).refresh()
  }

  /**
   * The value DSH's credential store holds for one name, if any.
   *
   * The store's own layer is the only one this page writes, and the provider
   * names it in `describe` — `file` for DSH's local provider. A name the store
   * does not hold answers undefined even while an environment layer supplies a
   * value, which is what keeps a clear a clear.
   */
  private async storedKey(name: string): Promise<string | undefined> {
    const ref = refOf(name)
    const credentials = this.credentials()
    if (ref === undefined || credentials === undefined) return undefined
    const info = await credentials.describe(ref)
    if (info.source !== STORED_LAYER) return undefined
    const value = (await credentials.resolve(ref))?.value
    return value === undefined || value === '' ? undefined : value
  }

  /** The value arbor resolves for one name: the store, else this process. */
  private async keyValue(name: string): Promise<string | undefined> {
    const value = await this.storedKey(name) ?? process.env[name]
    return value === undefined || value === '' ? undefined : value
  }

  /** Every name arbor reads a secret by: the judge's, then the configured ones. */
  private async keyNames(): Promise<readonly KeyName[]> {
    const settings = await this.environment.settings() ?? this.settings
    const names: KeyName[] = [{ name: JUDGE_KEY, purpose: 'judge' }]
    for (const name of settings.secrets ?? []) {
      if (!names.some(one => one.name === name)) names.push({ name, purpose: 'secret' })
    }
    // A name outside the credential grammar has no reference to miss, so it is
    // not a key this page can report or change.
    return names.filter(one => refOf(one.name) !== undefined)
  }

  /** One of the names arbor reads, as a credential reference, or a refusal. */
  private async keyRef(name: string): Promise<CredentialRef> {
    if (!(await this.keyNames()).some(one => one.name === name)) {
      throw new Error(`arbor does not read a key named ${JSON.stringify(name)}`)
    }
    const ref = refOf(name)
    if (ref === undefined) throw new Error(`${JSON.stringify(name)} is not a credential name`)
    return ref
  }

  /** DSH's credential store, on the profiles that mount one. */
  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials') as CredentialProvider | undefined
  }

  /**
   * Adopt the keys DSH's credential store already holds, and follow every later
   * change to them.
   *
   * A key saved on this page, a key saved on DSH's own Models page and a hand
   * edit of the credential file all land in the same document; the provider
   * reports each committed change, and this mirrors it into the environment
   * arbor resolves secrets from, so a value changed anywhere applies without a
   * restart. On a profile with no credential store the row is disabled and this
   * never runs, which is why the page reports those keys as read-only.
   */
  private async adoptCredentials(child: Context): Promise<void> {
    for (const key of await this.keyNames()) {
      const value = await this.keyValue(key.name)
      if (value === undefined) continue
      process.env[key.name] = value
    }
    await (this.requireState().host as unknown as { refresh(): Promise<void> }).refresh()
    child.on('credentials/reference-updated', (ref) => {
      void this.publishChangedKey(String(ref)).catch((error: unknown) => {
        this.ctx.logger.warn(`arbor: could not apply a changed credential: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }

  /** Mirror one credential changed elsewhere, when arbor reads that name. */
  private async publishChangedKey(name: string): Promise<void> {
    if (!(await this.keyNames()).some(one => one.name === name)) return
    await this.publishKey(name)
  }

  /**
   * Arbor's own workspace over the shared folder: the implementation every
   * window's files go through, and the one a read-only surface asks for the
   * chain's checkouts, keeps and open work.
   */
  get workspace(): Workspace {
    return this.requireState().workspace
  }

  /** The environment every window reads at `/env`, DSH's items mounted beside arbor's. */
  get environment(): Environment {
    return this.requireState().environment
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
   * The DSH session whose work this window runs, or undefined while nothing
   * attributes it. A window a restart continued before its session came back
   * answers undefined until the session resumes and its next turn opens the
   * window's own chain entry; the pointer section then reads no pointers rather
   * than another session's.
   */
  sessionOfWindow(window: WindowRef): SessionId | undefined {
    return this.windowSessions.get(window)
  }

  /**
   * The project of the shared folder the named window's session works in, or
   * undefined when it works in none.
   *
   * The project is read from the session's own current directory, which the
   * driver resolves into the shared folder for every arbor session — created
   * under arbor, re-routed onto it, or resumed after a restart — so a session the
   * user opened on a project and a session that picked arbor afterwards answer
   * the same way.
   */
  async projectOfWindow(window: WindowRef | undefined): Promise<ExternalProject | undefined> {
    if (window === undefined) return undefined
    const sessionId = this.windowSessions.get(window)
    if (sessionId === undefined) return undefined
    return this.requireState().projects.projectOf(await this.directoryOfSession(sessionId))
  }

  /**
   * The directory one session works in, the way DSH answers it.
   *
   * The `workingDirectory` projection is DSH's own answer for a session's
   * current directory — the cwd display, the session listing and the skill
   * catalog all read it — while the session header carries the directory the
   * session was created with and never moves. A session whose directory changed
   * therefore names the new one, which is what the project line has to say: the
   * alternative is a prompt that names a project the UI no longer shows.
   *
   * A window recovered before its session resumed has no live agent to read —
   * the host continues it at boot, long before the user opens the session again
   * — and its prefix is frozen then. The stored session header is the durable
   * answer for that moment, the same one the driver resolves a resume from, so
   * the recovered window opens naming the project it was opened on. It is read
   * once per session and remembered: a session's stored header never moves, and
   * the live answer takes over the moment the session is back.
   */
  /**
   * The directory one session works in, the way the `<workspace>` section reads
   * it: DSH's `workingDirectory` projection when the session is live, the
   * stored header otherwise. A read-only surface that names the session's
   * project asks this rather than re-deriving it.
   */
  directoryOf(sessionId: SessionId): Promise<string | undefined> {
    return this.directoryOfSession(sessionId)
  }

  private async directoryOfSession(sessionId: SessionId): Promise<string | undefined> {
    const session = this.ctx.agents.get(sessionId)?.session
    if (session !== undefined) {
      const projected = this.ctx.sessionProjections
        .snapshot(session, ['workingDirectory']).values.workingDirectory
      return projected ?? session.header.cwd
    }
    if (!this.storedCwds.has(sessionId)) {
      this.storedCwds.set(sessionId, await this.storedCwdOf(sessionId))
    }
    return this.storedCwds.get(sessionId)
  }

  /** The cwd a persisted session was created with, or undefined without a store. */
  private async storedCwdOf(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        return handle.header.cwd
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  /**
   * A revision that moves whenever anything the `<workspace>` section names
   * moves: any session's pointers, or any session's project. The host asks for it
   * once per step, so a window whose session picks another project before its
   * first turn is handed a delta of only the project line, and a session that
   * gains or loses a pointer is handed a delta of only that line.
   */
  private async workspaceRevision(): Promise<string> {
    const projects = this.requireState().projects
    const pointers = await projects.pointerRevision()
    const parts: string[] = []
    for (const sessionId of this.sessionProjects()) {
      const project = projects.projectOf(await this.directoryOfSession(sessionId))
      parts.push(`${sessionId}=${project?.path ?? ''}`)
    }
    return `${pointers}#${parts.sort().join(';')}`
  }

  /**
   * Every session the `<workspace>` section answers for: the live ones, plus the
   * ones a recovered window still names — a window the host continued at boot
   * belongs to a session whose agent is not back yet, and its project is part of
   * what the section says.
   */
  private sessionProjects(): readonly SessionId[] {
    const ids = new Set<SessionId>(this.ctx.agents.list().map(agent => agent.session.id))
    for (const sessionId of this.windowSessions.values()) ids.add(sessionId)
    return [...ids]
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
   * Whether the user added this directory through DSH's own add-workspace
   * action, outside the shared folder.
   *
   * This is what separates a directory the user means arbor to name from a cwd a
   * session merely inherited: the add-workspace action is the one path in DSH
   * that registers a directory of the user's choosing, so it is the only one
   * that may turn that directory into a pointer. The driver asks before it
   * records one.
   */
  isAddedArborDirectory(path: string): boolean {
    return this.requireState().projects.isAddedDirectory(path)
  }

  /**
   * Record an existing directory as an external pointer for one session: no
   * copy, no link, no adoption, never a registered project. The owner's decision
   * for an existing DSH project with its own path — the session works in arbor's
   * own directory (the shared folder) and the user's original directory is named
   * in arbor's prompt as a pointer, so the model reaches it directly. The driver
   * calls it for a session that became an arbor session while naming an added
   * directory; the model calls it for one it was asked about.
   */
  pointerArborProject(path: string, sessionId: SessionId): ExternalPointer {
    return this.requireState().projects.addPointer(sessionId, path)
  }

  /**
   * Make one arbor session a member of the workspace that owns the directory it
   * works in, so DSH's own hero composer has a workspace to name and stays live.
   *
   * The driver calls this for every arbor session it creates or re-routes, with
   * the cwd it resolved for it: an arbor session works in arbor's own directory,
   * and DSH filters a workspace's member list by the session's stored cwd, so
   * the session has to be a member of the workspace whose path is that
   * directory. See {@link DshProjectBridge.attachWorkspace} for why the composer
   * is inert without it.
   */
  attachArborWorkspace(sessionId: SessionId, cwd: string): Promise<void> {
    return this.requireState().projects.attachWorkspace(sessionId, cwd)
  }

  /** Drop a recorded external pointer by name for one session. */
  removeArborPointer(name: string, sessionId: SessionId): void {
    this.requireState().projects.removePointer(sessionId, name)
  }

  /**
   * Every external pointer one session recorded whose directory still exists,
   * true at read. This is what that session's `<workspace>` prompt section
   * names, and only that session's.
   */
  listArborPointers(sessionId: SessionId): Promise<readonly ExternalPointer[]> {
    return this.requireState().projects.listPointers(sessionId)
  }

  /** Every project registered from the shared folder, as DSH lists them. */
  listArborProjects(): Promise<readonly DshProject[]> {
    return this.requireState().projects.list()
  }

  /** The backend every window of this process runs through. */
  get backend(): DshBackend {
    return this.requireState().backend
  }

  /** Write the sends a step delivered, after all its tool results are on the log. */
  flushSends(): void {
    this.requireState().sendExecutor.flush()
  }

  /** The directory the journal and the note store live in. */
  get dataRoot(): string {
    return this.requireState().root
  }

  /**
   * Every window that serves this session, oldest first.
   *
   * A window carries the session's target in its own `window_start`, and a
   * continuation carries its predecessor instead; a chain therefore starts at a
   * target-carrying window and every continuation leads back to one. A session
   * can have several such roots — one per turn after an idle window ended — and
   * each root's continuations belong to the same session. The journal's start
   * order is what orders them all, and it is what the relay reads the chain's
   * tool calls back out of on resume.
   */
  async windowChainOf(sessionId: SessionId): Promise<WindowRef[]> {
    // A window carries the label its task named, and arbor carries that label
    // onto the window's continuations and the journal's record of both. The
    // label is the embedding's own session id, so it names this session's
    // windows directly - every root a turn after an idle end opened, and every
    // continuation of each - without walking targets or a process map.
    const labeled: Array<{ window: WindowRef; seq: number }> = []
    const { journal } = this.requireState()
    for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
      const page = await journal.list({ kinds: ['window_start'], limit: MAX_PAGE_LIMIT, offset })
      for (const event of page.items) {
        if (event.window === null) continue
        if (readLabel(event) === sessionId) labeled.push({ window: event.window, seq: event.seq })
      }
      if (page.items.length < MAX_PAGE_LIMIT) break
    }
    if (labeled.length > 0) {
      return labeled.sort((left, right) => left.seq - right.seq).map(entry => entry.window)
    }
    // A journal written before arbor carried labels has no direct answer; the
    // target walk it used is kept so an upgraded DSH_HOME stays readable.
    return this.windowChainByTarget(sessionId)
  }

  /**
   * The pre-label chain walk: the session's target names its first windows and
   * each continuation names its predecessor. Only a journal with no labels
   * reaches this; a current one answers by label.
   */
  private async windowChainByTarget(sessionId: SessionId): Promise<WindowRef[]> {
    const target = sessionTarget(sessionId)
    const { journal } = this.requireState()
    /** When each `window_start` was appended, in the journal's own order. */
    const startedAt = new Map<WindowRef, number>()
    /** The window each `window_start` names as its predecessor. */
    const previousOf = new Map<WindowRef, WindowRef>()
    /** The windows whose own start carries this session's target. */
    const roots = new Set<WindowRef>()
    for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
      const page = await journal.list({ kinds: ['window_start'], limit: MAX_PAGE_LIMIT, offset })
      for (const event of page.items) {
        if (event.window === null) continue
        startedAt.set(event.window, event.seq)
        if (event.targets.includes(target)) roots.add(event.window)
        const previous = continuedWindow(event.body)
        if (previous !== undefined) previousOf.set(event.window, previous)
      }
      if (page.items.length < MAX_PAGE_LIMIT) break
    }
    const rootOf = (window: WindowRef): WindowRef | undefined => {
      const seen = new Set<WindowRef>()
      let current: WindowRef | undefined = window
      while (current !== undefined && !seen.has(current)) {
        if (roots.has(current)) return current
        seen.add(current)
        current = previousOf.get(current)
      }
      return undefined
    }
    return [...startedAt.keys()]
      .filter(window => rootOf(window) !== undefined)
      .sort((left, right) => (startedAt.get(left) ?? 0) - (startedAt.get(right) ?? 0))
  }

  /**
   * Rebuild which session every recorded window serves, from the journal.
   *
   * The two hooks attribute a window the moment it opens — `windowStart` from
   * the task's targets, `windowContinue` from the window it continues — and that
   * map is process memory: it died with the process that wrote it. The journal
   * is the durable record of the same fact, because every `window_start` carries
   * the session's target and a continuation names its predecessor in its body.
   * So the attribution is rebuilt here, before the host starts, so that a window
   * the recovery continues opens with a prefix that still names its session.
   *
   * A window no chain leads back to a target — one dispatched from outside a DSH
   * session — is left unattributed, which is the answer the hooks give it too.
   */
  private async rebuildWindowSessions(): Promise<void> {
    const { journal } = this.requireState()
    const previous = new Map<WindowRef, WindowRef>()
    const sessions = new Map<WindowRef, SessionId>()
    for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
      const page = await journal.list({ kinds: ['window_start'], limit: MAX_PAGE_LIMIT, offset })
      for (const event of page.items) {
        if (event.window === null) continue
        const label = readLabel(event)
        if (label !== '') {
          // The embedding's own label, which arbor carried onto the window's
          // start and its continuations: no target matching is needed.
          sessions.set(event.window, label as SessionId)
        } else {
          // A journal written before labels carries the target instead.
          for (const target of event.targets) {
            const sessionId = sessionOfTarget(target)
            if (sessionId !== undefined) sessions.set(event.window, sessionId)
          }
        }
        const before = continuedWindow(event.body)
        if (before !== undefined) previous.set(event.window, before)
      }
      if (page.items.length < MAX_PAGE_LIMIT) break
    }
    // A continuation of a window whose start named no label inherits its
    // predecessor's attribution, however many continuations deep it runs.
    for (const window of previous.keys()) {
      if (sessions.has(window)) continue
      let current: WindowRef | undefined = previous.get(window)
      const seen = new Set<WindowRef>([window])
      while (current !== undefined && !seen.has(current)) {
        seen.add(current)
        const found = sessions.get(current)
        if (found !== undefined) {
          sessions.set(window, found)
          break
        }
        current = previous.get(current)
      }
    }
    for (const [window, sessionId] of sessions) this.windowSessions.set(window, sessionId)
  }

  /**
   * The window this session's work is running in, when it has a live one.
   *
   * The journal is the record of which window belongs to which session: every
   * `window_start` carries the label its task named, arbor carries that label
   * onto the window's continuations, and a window a restart stopped is continued
   * under a new ref with the same label. So the newest labeled start names the
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
