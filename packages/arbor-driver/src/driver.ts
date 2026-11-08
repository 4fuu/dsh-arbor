/**
 * The arbor driver: the AgentFactory that runs arbor-preset sessions, and the
 * Cordis plugin row that mounts it.
 *
 * One DSH user session is one conversation target of the process's single Arbor
 * host (`@4fu/dsh-arbor-host`): the journal, the note store and the board are
 * shared by every session, and each session is one source of that one host.
 * Arbor's own model is what a session's windows follow — a window ends when its
 * run ends and the session's next turn opens the next window of its chain, so
 * several windows serve one session and none of them is the session. Per
 * session the driver owns
 *
 *  - the window, opened through `host.dispatch` on the session's first turn and
 *    taken back — not reopened — when the session already has a live one, which
 *    is what a restart's continuation is;
 *  - the bridge the session agent drives: `ensureWindow`, `modelCall`,
 *    `runToolCall` (arbor's tool path into `ctx.tools.execute`), `publish`,
 *    `finishRun`, `close`; and
 *  - the window's DSH agent registration, which keeps it out of the session
 *    list (`meta.origin: 'subagent'`, owned by the session's agent).
 *
 * `resume` loads the persisted session, replays onto its log what the arbor
 * journal recorded and the log lost, and binds the session back to the window
 * the journal says is its own — the window the host continued at boot.
 *
 * The creation lifecycle mirrors `AgentLoop.createAgent`
 * (packages/core/agent-loop/src/index.ts): prepare the session, take
 * persistence ownership when a backend is mounted, run setup while the agent
 * is unpublished, then enter and announce the session and the agent through
 * the same registries the official loop uses.
 *
 * B1 scope, per the plan: compaction, goals, agentTeams, retry and fork are
 * off for arbor sessions.
 */

import { randomUUID } from 'node:crypto'
import { getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  AgentSetupCommit,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionPreparation, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// The `working-directory/change` event's declaration lives in the
// working-directory row's own types; importing it puts the augmentation in
// scope, which is what lets the driver read the event and the proof append one.
import type {} from '@deepseek-ai/dsh-working-directory'
import { sessionTarget, type ArborHostService } from '@4fu/dsh-arbor-host'
import { replacedToolsRegistered } from '@4fu/dsh-arbor-tools'
import { dataBlock } from '@4fu/arbor-prompt'
import type { TaskInput, WindowRef } from '@4fu/arbor-interfaces'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { InboxState, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { ARBOR_PRESET, ArborAgentRegistry } from './registry.ts'
import { ArborSessionAgent, type ArborWindowBridge } from './session-agent.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { relayToolCalls, windowToolCalls } from './relay.ts'

/** Plugin config: the arbor settings live in the host row, so there is nothing here. */
export type Config = Record<string, never>

/** What the driver exposes about one session's arbor world. */
export interface SessionArborLike {
  /** The window this session's work runs in, once it has one. */
  readonly windowRef: WindowRef | undefined
  /** The agent registered for this session's window, once one exists. */
  readonly windowAgentOf: Agent | undefined
}

/**
 * One session the embedded AgentLoop is running, as far as this driver needs it:
 * the handle that can end it, and the create options a re-route replays.
 */
interface EmbeddedHold {
  readonly handle: AgentHandle
  readonly agentOptions: AgentOptions | undefined
  readonly setup: AgentSetup | undefined
}

/**
 * The options an arbor resume takes: DSH's own, plus the cwd the session resumes
 * with. A re-route passes the cwd it resolved from the directory the user picked,
 * and a restart passes none so the stored header's own is resolved here — either
 * way the live session names the shared folder or a project of it.
 */
interface ResumeArborOptions extends ResumeAgentOptions {
  readonly cwd?: string | undefined
}

/** One session's arbor world: its window, its bridge, its window agent. */
class SessionArbor {
  private window: WindowRef | undefined
  private windowAgent: Agent | undefined
  private bridgeCache: ArborWindowBridge | undefined
  /** The session's write handle onto its durable log, once persistence is mounted. */
  private stored: { handle: SessionHandle; storedCount: number } | undefined

  readonly agent: ArborSessionAgent
  /** The create/resume options a re-route replays, so a session keeps its own. */
  readonly agentOptions: AgentOptions | undefined
  readonly agentSetup: AgentSetup | undefined

  private readonly driver: ArborDriver

  constructor(
    driver: ArborDriver,
    agent: ArborSessionAgent,
    agentOptions: AgentOptions | undefined,
    agentSetup: AgentSetup | undefined,
  ) {
    this.driver = driver
    this.agent = agent
    this.agentOptions = agentOptions
    this.agentSetup = agentSetup
  }

  /** Hand this world the session's write handle, once it has one. */
  keepStored(stored: { handle: SessionHandle; storedCount: number } | undefined): void {
    this.stored = stored
  }

  /**
   * End this session's arbor world: unbind its window, unwind the agent's own
   * scope — which detaches the agent and its session and closes the bridge — and
   * release the session's write handle so another driver can open the log.
   *
   * This is the teardown a re-route needs in either direction, and it is the
   * mirror of the embedded loop's own `AgentHandle.dispose`: the window itself is
   * the host's and lives out arbor's own idle policy, so only the binding goes.
   */
  async dispose(): Promise<void> {
    await this.agent.scope.dispose()
    await this.stored?.handle.close().catch(() => {})
    this.stored = undefined
  }

  /** The one Arbor host of this process, and the backend every window runs through. */
  private get hostService(): ArborHostService {
    return this.driver.hostService
  }

  /** The window this session's work runs in, once it has one. */
  get windowRef(): WindowRef | undefined {
    return this.window
  }

  /** Whether the window this session holds is still the host's. */
  private isLive(window: WindowRef | undefined): boolean {
    if (window === undefined) return false
    return this.hostService.host.live().some(record => record.window === window && record.state !== 'ended')
  }

  /** Open the window on first use, through arbor's dispatch. */
  async ensureWindow(): Promise<WindowRef> {
    const held = this.window
    if (held !== undefined && this.isLive(held)) return held
    // A window this session already has is taken back, not answered by a second
    // one: a restart continues the session's window under a new ref, and an
    // earlier turn's window is still open while it waits out its idle period.
    const existing = await this.hostService.windowFor(this.agent.session.id)
    const window = existing ?? await this.dispatchWindow()
    this.window = window
    this.hostService.backend.bind(window, this.agent)
    await this.hostService.backend.whenOpen(window)
    await this.registerWindowAgent(window)
    return window
  }

  /** Dispatch this session's task, which opens the window that takes it. */
  private async dispatchWindow(): Promise<WindowRef> {
    const session = this.agent.session
    const task: TaskInput = {
      kind: 'batch',
      reason: 'a DeepSeek Harness session turn',
      targets: [sessionTarget(session.id)],
      time: Date.now(),
      content: [dataBlock(`dsh session ${session.id}`)],
      explicit: true,
      source: 'dsh',
    }
    const result = await this.hostService.host.dispatch(task)
    if (result.window === null) {
      throw new Error(`arbor driver: dispatch opened no window for session "${session.id}" (route ${result.route})`)
    }
    return result.window
  }

  /**
   * Register the window as a DSH agent with `meta.origin: 'subagent'`, the
   * convention `packages/subagent/subagent/src/child-agent.ts` uses for
   * delegated children: the registry and the agent-team tools see the window,
   * and the sidebar's `sessionVisible`
   * (packages/client/ui-workspace/src/client/tree.ts) leaves it out. The agent
   * is owned by this session's agent, so it is not a registry root.
   */
  private async registerWindowAgent(window: WindowRef): Promise<void> {
    if (this.windowAgent !== undefined) return
    const sessionId = brandString<SessionId>(`window-${window}-${randomUUID()}`)
    const { agent } = await this.driver.driverContext.agents.create({
      sessionId,
      parentAgent: this.agent,
      meta: {
        origin: 'subagent',
        parentSession: this.agent.session.id,
        // The window works in the arbor shared folder, so its hidden agent's cwd
        // is that folder rather than the DSH process's own directory.
        cwd: this.hostService.sharedFolder,
      },
      agentOptions: {},
    })
    this.windowAgent = agent
  }

  /** The agent registered for this session's window, once one exists. */
  get windowAgentOf(): Agent | undefined {
    return this.windowAgent
  }

  /** The bridge the session agent drives. */
  bridge(): ArborWindowBridge {
    this.bridgeCache ??= {
      ensureWindow: () => this.ensureWindow(),
      systemPrompt: window => this.hostService.backend.systemPrompt(window),
      modelCall: input => this.hostService.backend.modelCall({ ...input, agent: this.agent }),
      runToolCall: async (call, position) => {
        const window = await this.ensureWindow()
        const control = this.hostService.host.windowControl()
        const args = safeArgs(call.arguments)
        const at = await control.recordToolCall(window, { name: call.name, args, callId: call.id })
        // The call is mirrored onto the session log here, for every tool the
        // window runs — arbor's own and DSH's alike. The log is the history the
        // next model request is derived from, and a provider refuses a history
        // whose assistant message asks for a tool call that has no result, so a
        // window that runs only arbor's own tools still leaves a valid log.
        // DSH's pipeline is not asked to log (the external tools carry no log
        // position), which is what keeps this the one pair per call.
        const callSeq = this.agent.session.append('tool/call', {
          ...position,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        }).seq
        const result = await control.runToolCall(window, { name: call.name, args, callId: call.id }, at ?? undefined)
        this.agent.session.append('tool/result', {
          ...position,
          message: createToolResultMessage({
            callId: call.id,
            // Arbor 2026.1107.1 fills a refusal's wording into `content` as well
            // as into `error` — the rule, the message and the next action, in the
            // one form the journal records a refusal with — so the result is
            // written through as it stands. DSH's own tools put a denial's
            // reason in the content too, and without this the model would read
            // an empty tool result and never learn why a call was refused.
            content: [{ type: 'text', text: result.content }],
            isError: !result.ok,
          }),
          ...result.ok ? {} : { error: toolErrorOf(result) },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        return result
      },
      publish: (window, event) => { this.hostService.backend.publish(window, event) },
      finishRun: window => { this.hostService.backend.finishRun(window) },
      close: async () => {
        // The window is the host's, not this session's: it stays open for the
        // session's next turn and ends on arbor's own idle policy, exactly like
        // a window whose model went quiet. Only the binding is dropped.
        if (this.window !== undefined) this.hostService.backend.unbind(this.window)
      },
    }
    return this.bridgeCache
  }
}

/** The arbor agent factory and Cordis plugin. */
export class ArborDriver extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'sessionProjections', 'arborHost', 'tools', 'systemPrompt']

  static Config: z<Config, Config> = z.object({}) as unknown as z<Config, Config>

  readonly config: Config
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }
  private readonly sessions = new Map<SessionId, SessionArbor>()
  /**
   * Sessions the embedded AgentLoop is running, with the handle its creation
   * returned. The driver created every one of them — the registry routes every
   * session through this factory — so it holds the only thing that can end one:
   * that is what lets a preset selection re-route a session that has not started
   * a turn. An ordinary session is never touched unless its user picks arbor.
   */
  private readonly embedded = new Map<SessionId, EmbeddedHold>()
  private modelProjectionHandle!: ProjectionHandle<ModelSelectionProjectionState>
  private inboxProjectionHandle!: ProjectionHandle<InboxState>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'arborDriver')
    this.config = config
    this.runtime = { ctx }
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.runtime.ctx
    // Refcounted alongside the embedded AgentLoop's own registrations of the
    // same keys (SessionProjectionRegistry.register shares one definition per
    // key), so an arbor agent reads its projections with or without the
    // official loop mounted.
    this.modelProjectionHandle = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
    this.inboxProjectionHandle = await ctx.sessionProjections.register(inboxProjectionDefinition)
    ctx.effect(() => (ctx.agents as ArborAgentRegistry).useArborFactory(this), 'arborDriver.useArborFactory()')
    // The seam that makes picking Arbor in a composer actually run arbor. DSH's
    // own preset registry commits a blank session's pick by appending
    // `agent-preset/selected` and re-mounting the session's composition, which is
    // all a preset whose presets share one driver needs; a preset that changes the
    // driver has to act on the same event. The log event is observed rather than
    // the registry's own `agent-preset/selected` emit, because that one is
    // dispatched on the registry's context and reaches nobody outside it, while
    // `session/event` is the session-scoped observer channel every host row can
    // listen on. A session that has started a turn never gets here — the registry
    // refuses that selection before it is committed — so the only case is a
    // session still waiting for its first turn, which is exactly the hero.
    // The event carries the OTHER direction too, and it has to be honoured: DSH's
    // session controller re-selects the default preset whenever a blank session is
    // reused (`reuseLive` calls `presets.select` with the resolved default), so an
    // arbor session the user then opens in another workspace is relabelled
    // `standard` while it still runs arbor. Following the event back is what keeps
    // the label and the driver saying the same thing.
    ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
      if (event.type !== 'agent-preset/selected') return
      const selected = (event.data as { agentPreset?: unknown }).agentPreset
      if (selected === ARBOR_PRESET) {
        void this.rerouteToArbor(session.id).catch((error: unknown) => {
          this.runtime.ctx.logger.warn(
            `arbor driver: re-routing session ${session.id} to arbor failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        return
      }
      void this.rerouteToEmbedded(session.id).catch((error: unknown) => {
        this.runtime.ctx.logger.warn(
          `arbor driver: re-routing session ${session.id} off arbor failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    })
  }

  /**
   * Re-route one session from the embedded AgentLoop to arbor.
   *
   * The loop's agent is ended with the handle its creation returned — which
   * unregisters the agent and detaches the session from the store, leaving the
   * durable log exactly as it stands — and the session is then opened again
   * under arbor, the way a restart opens it. The session keeps its identity, its
   * log and every event it already committed, so the composer that is bound to
   * it keeps working; what changes is which driver its next turn runs.
   */
  private async rerouteToArbor(sessionId: SessionId): Promise<void> {
    const hold = this.embedded.get(sessionId)
    if (hold === undefined) return
    this.embedded.delete(sessionId)
    // A session that has started a turn keeps the driver it began with. DSH's
    // preset registry refuses such a selection before it is committed, so this
    // is a guard rather than a path; it is here because the alternative —
    // silently keeping the old driver — is the one thing the owner ruled out.
    const boundary = this.runtime.ctx.agents.turnBoundaryOf(hold.handle.agent.session)
    if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
      this.runtime.ctx.logger.warn(
        `arbor driver: session ${sessionId} selected arbor after its first turn and keeps the embedded loop`,
      )
      return
    }
    // The re-routed session keeps the cwd it was created with — the directory the
    // user picked for it in DSH's own project picker — and arbor works in the
    // shared folder, so the picked directory is what the pointer names. It is
    // read before the embedded agent is ended, and recorded once, at the moment
    // the session becomes an arbor session: that is the ask, and it is not
    // repeated on a later resume.
    const requested = hold.handle.agent.session.header.cwd
    await hold.handle.dispose()
    await this.resumeArbor(this.runtime.ctx, {
      resumeSessionId: sessionId,
      agentOptions: hold.agentOptions,
      setup: hold.setup,
      cwd: await this.hostService.resolveArborCwd(requested),
    })
    this.noteExternalProject(requested, sessionId)
  }

  /**
   * Record a directory an arbor session named as an external pointer for that
   * session, when the user had added the directory through DSH's own
   * add-workspace action.
   *
   * The host answers whether the directory was added, because that is a fact
   * about the project list rather than about this session; a directory that was
   * never added — a cwd the session inherited — is left alone, which is the
   * mistake the earlier resolve-time recording made.
   */
  private noteExternalProject(requested: string | undefined, sessionId: SessionId): void {
    if (requested === undefined) return
    try {
      if (this.hostService.isAddedArborDirectory(requested)) {
        this.hostService.pointerArborProject(requested, sessionId)
      }
    } catch (error: unknown) {
      this.runtime.ctx.logger.warn(
        `arbor driver: recording an external pointer for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Re-route one session from arbor back to the embedded AgentLoop.
   *
   * The mirror of {@link rerouteToArbor}, and it exists for the same reason: a
   * session's label and the driver under it must say the same thing. DSH re-selects
   * the default preset when a blank session is reused, and a user may pick another
   * preset on a blank session at any time, so a session that selected arbor can
   * select something else again while it is still waiting for its first turn. The
   * arbor agent is ended with the handle this driver holds, the window keeps
   * running out arbor's own idle policy, and the session is opened again on the
   * embedded loop with the same id, the same log and the same cwd it was created
   * with.
   *
   * A session that has started a turn keeps the driver it began with: DSH refuses
   * that selection before it is committed, so this is the same defensive guard the
   * arbor direction carries, and the alternative — silently keeping the old driver
   * — is the one outcome the owner ruled out.
   */
  private async rerouteToEmbedded(sessionId: SessionId): Promise<void> {
    const arbor = this.sessions.get(sessionId)
    if (arbor === undefined) return
    this.sessions.delete(sessionId)
    const boundary = this.runtime.ctx.agents.turnBoundaryOf(arbor.agent.session)
    if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
      this.runtime.ctx.logger.warn(
        `arbor driver: session ${sessionId} selected another preset after its first turn and keeps arbor`,
      )
      return
    }
    const options: ResumeAgentOptions = {
      resumeSessionId: sessionId,
      agentOptions: arbor.agentOptions,
      setup: arbor.agentSetup,
    }
    await arbor.dispose()
    await this.resumeEmbedded(this.runtime.ctx, options)
  }

  /** The driver's own DSH context, for the per-session arbor worlds. */
  get driverContext(): Context {
    return this.runtime.ctx
  }

  /** The one Arbor host of this process. */
  get hostService(): ArborHostService {
    const host = this.runtime.ctx.get('arborHost')
    if (host === undefined) {
      throw new Error('arbor driver: no arborHost service (load @4fu/dsh-arbor-host)')
    }
    return host
  }

  /** The per-session arbor world, for tests and diagnostics. */
  sessionArbor(sessionId: SessionId): SessionArborLike | undefined {
    return this.sessions.get(sessionId)
  }

  /** The agent registered for a session's arbor window, once one exists. */
  windowAgentOf(sessionId: SessionId): Agent | undefined {
    return this.sessions.get(sessionId)?.windowAgentOf
  }

  /** The system prompt the session's arbor window rendered, once it opened. */
  systemPromptOf(sessionId: SessionId): string | undefined {
    const window = this.sessions.get(sessionId)?.windowRef
    return window === undefined ? undefined : this.hostService.backend.systemPrompt(window)
  }

  /**
   * Whether a persisted session runs under arbor.
   *
   * The creation header names the preset a session STARTED with and is frozen
   * because it is a creation fact; a session may still select another while it
   * is blank, and DSH's own reconstruction rule for exactly this reason reads
   * the `agentPreset` projection, "never the header alone"
   * (`@deepseek-ai/dsh-agent-preset-registry`, `lib/types/session.js`). So the
   * log's `agent-preset/selected` events are folded over the header's value:
   * that is what makes a re-routed session come back as arbor after a restart
   * instead of silently resuming on the embedded loop.
   */
  async ownsSession(sessionId: SessionId): Promise<boolean> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        let preset: string | undefined = handle.header.agentPreset
        const page = await handle.read(0)
        for (const event of page.events) {
          if (event.type !== 'agent-preset/selected') continue
          const selected = (event.data as { agentPreset?: unknown }).agentPreset
          if (typeof selected === 'string') preset = selected
        }
        return preset === ARBOR_PRESET
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // A session created under the arbor preset runs arbor; every other session
    // runs the embedded AgentLoop. The registry routes both here, because the
    // driver has to hold the embedded handle to be able to re-route a session
    // whose user picks arbor before its first turn.
    if (options.meta?.agentPreset === ARBOR_PRESET) return this.createArborAgent(ownerCtx, options)
    const hold = await this.createEmbedded(ownerCtx, options)
    return {
      agent: hold.handle.agent,
      dispose: async () => {
        this.embedded.delete(hold.handle.agent.id)
        await hold.handle.dispose()
      },
    }
  }

  /** Create the agent of a session that runs arbor. */
  private async createArborAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // An arbor session is not bound to the caller's directory: it works in the
    // arbor shared folder, and a requested directory outside it joins the shared
    // folder only through explicit adoption (see @4fu/dsh-arbor-workspace). The
    // session's cwd is therefore resolved into the shared folder before the
    // session is prepared, so the DSH session, its cwd display and the project
    // picker all name a folder that is really there.
    const requested = options.meta?.cwd as string | undefined
    const meta = options.meta === undefined
      ? { cwd: await this.hostService.resolveArborCwd(undefined) }
      : { ...options.meta, cwd: await this.hostService.resolveArborCwd(requested) }
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      meta,
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const id = preparation.session.id
    // A directory the user added through DSH's own add-workspace action, named by
    // a session that is starting under arbor, is a pointer for that session: the
    // user chose the directory for this session, and arbor's prompt names it so
    // the model can work in the user's own files. A cwd the session merely
    // inherited is not, which is why the question is asked of the host rather
    // than assumed here.
    this.noteExternalProject(requested, id)
    const agent = this.agentFor(preparation.session, options.agentOptions)
    const arbor = new SessionArbor(this, agent, options.agentOptions, options.setup)
    agent.attachBridge(arbor.bridge())
    this.sessions.set(id, arbor)
    let stored: { handle: SessionHandle; storedCount: number } | undefined
    try {
      ownerCtx.fiber.assertActive()
      stored = await this.createStoredSession(preparation.session, options.signal)
      arbor.keepStored(stored)
      await this.publish(ownerCtx, arbor, agent, preparation.session, stored, options.setup, 'startup', options.parentAgent, options.signal)
    } catch (error: unknown) {
      this.sessions.delete(id)
      await arbor.bridge().close()
      await stored?.handle.close().catch(() => {})
      throw error
    } finally {
      preparation[Symbol.dispose]()
    }
    return {
      agent,
      dispose: async () => {
        this.sessions.delete(id)
        await arbor.dispose()
      },
    }
  }

  /**
   * Create an agent for a session the embedded AgentLoop will run.
   *
   * The embedded factory is delegated to exactly the way the base
   * `AgentRegistry` delegates, so an ordinary session's agent, its ownership and
   * its teardown are the official loop's own. The one difference is that this
   * driver keeps the handle: a session whose user later picks arbor is re-routed
   * by ending the loop's agent and opening the session's arbor window, and
   * ending an agent needs the handle its creation returned.
   */
  private async createEmbedded(ownerCtx: Context, options: CreateAgentOptions): Promise<EmbeddedHold> {
    const registry = this.runtime.ctx.agents as ArborAgentRegistry
    const factory = registry.embedded
    if (factory === undefined) {
      throw new Error('no agent factory registered (load an agent-loop plugin)')
    }
    const handle = await delegateFactory(ownerCtx, factory, 'createAgent', options)
    const hold: EmbeddedHold = {
      handle,
      agentOptions: options.agentOptions,
      setup: options.setup,
    }
    this.embedded.set(handle.agent.id, hold)
    return hold
  }

  /** Resume an agent for a session the embedded AgentLoop will run. */
  private async resumeEmbedded(ownerCtx: Context, options: ResumeAgentOptions): Promise<EmbeddedHold> {
    const registry = this.runtime.ctx.agents as ArborAgentRegistry
    const factory = registry.embedded
    if (factory === undefined) {
      throw new Error('no agent factory registered (load an agent-loop plugin)')
    }
    const handle = await delegateFactory(ownerCtx, factory, 'resume', options)
    const hold: EmbeddedHold = { handle, agentOptions: options.agentOptions, setup: options.setup }
    this.embedded.set(handle.agent.id, hold)
    return hold
  }

  /**
   * Resume a persisted arbor session.
   *
   * The session's log is loaded the way the official loop loads it, with two
   * arbor-specific steps around it: the window chain the journal holds is read
   * back and the `tool/call` events the log lost are replayed onto it, so DSH's
   * own `interruptedTurnClosers` closes them as outcome-unknown rather than
   * not-started; and the session is bound to the window the host continued at
   * boot, so its next turn drives that window instead of opening a new chain.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // A persisted session runs arbor when its log says so — the creation header
    // names the preset it started with and a blank session may still have
    // selected another, which is why the log is folded rather than the header
    // read. Everything else runs the embedded AgentLoop, with its handle kept
    // for the same reason `createAgent` keeps one.
    if (await this.ownsSession(options.resumeSessionId)) {
      // A restart resolves the stored cwd the way a creation resolves a requested
      // one, so the session comes back naming the shared folder or the project
      // the user pointed it at — never the directory it happened to be created
      // in before it selected arbor.
      const persistence = this.runtime.ctx.get('sessionPersistence')
      const stored = persistence === undefined ? undefined : await this.storedCwd(persistence, options.resumeSessionId)
      return this.resumeArbor(ownerCtx, {
        ...options,
        cwd: await this.hostService.resolveArborCwd(stored),
      })
    }
    const hold = await this.resumeEmbedded(ownerCtx, options)
    return {
      agent: hold.handle.agent,
      dispose: async () => {
        this.embedded.delete(hold.handle.agent.id)
        await hold.handle.dispose()
      },
    }
  }

  /**
   * The cwd a persisted session was created with, read without taking its write
   * ownership: the resume path needs it to resolve the session's cwd before it
   * opens the log for writing.
   */
  private async storedCwd(persistence: SessionPersistence, sessionId: SessionId): Promise<string | undefined> {
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

  /** Resume a persisted session that runs arbor. */
  private async resumeArbor(ownerCtx: Context, options: ResumeArborOptions): Promise<AgentHandle> {
    const ctx = this.runtime.ctx
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    let open: SessionHandle | undefined
    let preparation: SessionPreparation | undefined
    let stored: { handle: SessionHandle; storedCount: number } | undefined
    let agent: ArborSessionAgent | undefined
    let arbor: SessionArbor | undefined
    try {
      open = await persistence.open(id, 'write', {
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      const coldRead = await open.read(0)
      const windows = await this.hostService.windowChainOf(id)
      const recorded = await windowToolCalls(this.hostService.journal, windows)
      const relayed = relayToolCalls(coldRead.events, recorded)
      if (relayed.length > 0) await open.append(relayed)
      const closers = interruptedTurnClosers([...coldRead.events, ...relayed])
      if (closers.length > 0) await open.append(closers)
      const seed = [...coldRead.events, ...relayed, ...closers]
      preparation = SessionPreparation.create(ctx.sessions.prepare(id, {
        seed,
        // The cwd a persisted session resumes with is resolved into the shared
        // folder exactly as a creation resolves it, so a session created under
        // arbor, one re-routed onto it and one resumed after a restart all name
        // the same directory: the shared folder, or the project subfolder the
        // user pointed the session at. The stored header keeps what creation
        // wrote; the live session is what the model, the cwd display and the
        // project line all read.
        meta: { ...structuredClone(open.header), cwd: options.cwd ?? open.header.cwd },
        inheritedEventCount: open.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      stored = { handle: open, storedCount: seed.length }
      open = undefined
      await this.appendUnstoredSuffix(stored, preparation.session)
      agent = this.agentFor(preparation.session, options.agentOptions)
      arbor = new SessionArbor(this, agent, options.agentOptions, options.setup)
      agent.attachBridge(arbor.bridge())
      this.sessions.set(id, arbor)
      arbor.keepStored(stored)
      await this.publish(ownerCtx, arbor, agent, preparation.session, stored, options.setup, 'resume', options.parentAgent, options.signal)
    } catch (error: unknown) {
      if (agent !== undefined) this.sessions.delete(id)
      await arbor?.bridge().close()
      await stored?.handle.close().catch(() => {})
      throw error
    } finally {
      preparation?.[Symbol.dispose]()
      await open?.close().catch(() => {})
    }
    const live = { agent, arbor }
    return {
      agent: live.agent,
      dispose: async () => {
        this.sessions.delete(id)
        await live.arbor?.dispose()
      },
    }
  }

  /** Build the session agent for one prepared session, create or resume. */
  private agentFor(session: Session, options: AgentOptions | undefined): ArborSessionAgent {
    return new ArborSessionAgent(
      this.runtime.ctx,
      session.id,
      options ?? {},
      session,
      {
        modelSelection: this.modelProjectionHandle.readerFor(session),
        inbox: this.inboxProjectionHandle.readerFor(session),
      },
      this.runtime.ctx.agents.turnBoundaryOf(session).lastTurn,
    )
  }

  /** Take a fresh session's write ownership when persistence is mounted. */
  private async createStoredSession(
    session: Session,
    signal?: AbortSignal,
  ): Promise<{ handle: SessionHandle; storedCount: number } | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /** Durably store the session events appended since the last stored cursor. */
  private async appendUnstoredSuffix(
    stored: { handle: SessionHandle; storedCount: number } | undefined,
    session: Session,
  ): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(stored.storedCount as never)
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /** Enter and announce the session and the agent, exactly like AgentLoop does. */
  private async publish(
    ownerCtx: Context,
    arbor: SessionArbor,
    agent: Agent,
    session: Session,
    stored: { handle: SessionHandle; storedCount: number } | undefined,
    setup: AgentSetup | undefined,
    source: SessionStartSource,
    parentAgent: Agent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const loopCtx = this.runtime.ctx
    await agent.runMaintenance(async () => {
      if (stored !== undefined) {
        const suffix = session.snapshotEvents(stored.storedCount as never)
        if (suffix.length > 0) await stored.handle.append(suffix)
        stored.storedCount += suffix.length
      }
      const detachSession = agent.ctx.sessions.enter(session)
      agent.ctx.sessions.announce(session)
      // Every capability appears once: the DSH tools arbor's own replaces are
      // denied in this session's scope, so DSH's own pipeline refuses them and
      // their `tool:*` prompt sections render empty. The same list keeps them
      // out of what the backend hands arbor's catalog
      // (`@4fu/dsh-arbor-tools` DSH_TOOLS_ARBOR_REPLACES). The restriction is
      // scoped to this agent — `tools.restrict` refuses a global one — and is
      // disposed with the agent's own context.
      const liftRestriction = agent.ctx.tools.restrict({
        deny: replacedToolsRegistered(loopCtx.tools),
      })
      const commit: AgentSetupCommit | void = await setup?.(agent.ctx, agent)
      commit?.commit()
      // A `tool:*` section's text reads whether its tool is registered, and the
      // restriction moves that without a registration change, so the prompt
      // bridge is told the prompt moved.
      this.hostService.noteDshPromptChange()
      const detachAgent = loopCtx.agents.enter(agent, parentAgent)
      await loopCtx.agents.announce(agent, source, signal)
      agent.ctx.effect(function* () {
        yield () => {
          detachAgent()
          detachSession()
        }
        yield async () => { await arbor.bridge().close() }
      }, 'arborDriver.detach()')
      agent.ctx.effect(() => liftRestriction, 'arborDriver.restrictTools()')
    })
  }
}

/**
 * Delegate to one factory exactly the way the base `AgentRegistry` does, so an
 * embedded-loop session's agent, ownership and teardown stay the official loop's
 * own even though this driver is the one calling it.
 */
function delegateFactory(
  ownerCtx: Context,
  factory: AgentFactory,
  method: 'createAgent' | 'resume',
  options: CreateAgentOptions | ResumeAgentOptions,
): Promise<AgentHandle> {
  const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
  const receiver = getTraceable(ownerCtx, target)
  return Reflect.apply(target[method], receiver, [ownerCtx, options]) as Promise<AgentHandle>
}

/** Parse a model-produced arguments string; invalid JSON becomes an empty object. */
function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** One refused tool call as the session log's error shape. */
function toolErrorOf(result: { error?: { rule: string; message: string } }): {
  name: string
  code: string
  reason?: string
} {
  return {
    name: result.error?.rule ?? 'ToolCallFailed',
    code: 'TOOL_CALL_FAILED',
    ...result.error === undefined ? {} : { reason: result.error.message },
  }
}

export default ArborDriver
