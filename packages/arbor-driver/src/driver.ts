/**
 * The arbor driver: the AgentFactory that runs arbor-preset sessions, and the
 * Cordis plugin row that mounts it.
 *
 * One DSH user session is one arbor window of the process's single Arbor host
 * (`@4fu/dsh-arbor-host`): the journal, the note store and the board are shared
 * by every session, and each session is one conversation target of that one
 * host. Per session the driver owns
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
import { Service } from '@deepseek-ai/cordis'
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
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { sessionTarget, type ArborHostService } from '@4fu/dsh-arbor-host'
import { dataBlock } from '@4fu/arbor-prompt'
import type { TaskInput, WindowRef } from '@4fu/arbor-interfaces'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { InboxState, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { ArborAgentRegistry } from './registry.ts'
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

/** One session's arbor world: its window, its bridge, its window agent. */
class SessionArbor {
  private window: WindowRef | undefined
  private windowAgent: Agent | undefined
  private bridgeCache: ArborWindowBridge | undefined

  readonly agent: Agent

  private readonly driver: ArborDriver

  constructor(driver: ArborDriver, agent: Agent) {
    this.driver = driver
    this.agent = agent
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
        ...this.driver.driverContext.get('fs') === undefined ? {} : { cwd: process.cwd() },
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
  static inject = ['agents', 'sessions', 'sessionProjections', 'arborHost']

  static Config: z<Config, Config> = z.object({}) as unknown as z<Config, Config>

  readonly config: Config
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }
  private readonly sessions = new Map<SessionId, SessionArbor>()
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

  /** Whether a persisted session runs under arbor. */
  async ownsSession(sessionId: SessionId): Promise<boolean> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        return handle.header.agentPreset === 'arbor'
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const id = preparation.session.id
    const agent = this.agentFor(preparation.session, options.agentOptions)
    const arbor = new SessionArbor(this, agent)
    agent.attachBridge(arbor.bridge())
    this.sessions.set(id, arbor)
    this.hostService.noteSessionCwd(id, preparation.session.header.cwd)
    let stored: { handle: SessionHandle; storedCount: number } | undefined
    try {
      ownerCtx.fiber.assertActive()
      stored = await this.createStoredSession(preparation.session, options.signal)
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
        await arbor.bridge().close()
        await stored?.handle.close().catch(() => {})
      },
    }
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
        meta: structuredClone(open.header),
        inheritedEventCount: open.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      stored = { handle: open, storedCount: seed.length }
      open = undefined
      await this.appendUnstoredSuffix(stored, preparation.session)
      agent = this.agentFor(preparation.session, options.agentOptions)
      arbor = new SessionArbor(this, agent)
      agent.attachBridge(arbor.bridge())
      this.sessions.set(id, arbor)
      this.hostService.noteSessionCwd(id, preparation.session.header.cwd)
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
    const live = { agent, arbor, stored }
    return {
      agent: live.agent,
      dispose: async () => {
        this.sessions.delete(id)
        await live.arbor?.bridge().close()
        await live.stored?.handle.close().catch(() => {})
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
      const commit: AgentSetupCommit | void = await setup?.(agent.ctx, agent)
      commit?.commit()
      const detachAgent = loopCtx.agents.enter(agent, parentAgent)
      await loopCtx.agents.announce(agent, source, signal)
      agent.ctx.effect(function* () {
        yield () => {
          detachAgent()
          detachSession()
        }
        yield async () => { await arbor.bridge().close() }
      }, 'arborDriver.detach()')
    })
  }
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
