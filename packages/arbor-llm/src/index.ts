/**
 * The arbor `AgentBackend` that runs each window through DSH.
 *
 * One DSH process mounts one Arbor host (see `@4fu/dsh-arbor-host`), so this
 * backend is one object that serves every session's windows. Per window it
 * holds the frozen epoch the host opened it with — the rendered system prompt
 * and the declared direct tools, DSH's among them — plus the window's live
 * event bus. Per window it also holds the DSH session agent whose turns drive
 * it, bound by the driver when the session is created or resumed.
 *
 * This is the seam where arbor's window lifecycle meets DSH's services:
 *
 *  - `open(request)` captures the window's frozen epoch and returns the window
 *    session the host watches. It needs no agent: a window a restart continued
 *    opens before any session is resumed onto it.
 *  - `modelCall` — used by the DSH-side session agent for each of its steps —
 *    resolves the route, logs the `request/header`, and streams through
 *    `ctx.llm.stream`; the request itself is derived from the session log by
 *    the agent's owner.
 *  - `externalTools()` hands DSH's registered tools to arbor, so the model
 *    declares and calls them like any other direct tool; execution lands back
 *    in `ctx.tools.execute` with the session agent of the turn that is running,
 *    which is what routes approvals through DSH's approval path and appends the
 *    durable `tool/call` + `tool/result` pair to that session's log.
 *
 * The window session is a live event bus: the agent publishes text deltas,
 * tool calls and run boundaries, and the host's `watch` loop consumes them
 * like any backend's.
 */

import type { Agent, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, PreparedLlmCall, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createDeveloperMessage, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type {
  AgentBackend,
  Delivery,
  DirectToolSpec,
  ExternalTool,
  Handoff,
  LoginResult,
  ModelInfo,
  OpenWindowRequest,
  WindowEndReason,
  WindowEvent,
  WindowOutcome,
  WindowRef,
  WindowSession,
  WindowState,
} from '@4fu/arbor-interfaces'
import { renderDelivery } from '@4fu/arbor-prompt'
import type { Renderer } from '@4fu/arbor-prompt'
import { dshExternalTools, schemaOf } from '@4fu/dsh-arbor-tools'

// The source kind a delivery from arbor's host is steered in as: one user-role
// input the framework inserted, which is what separates it from a message the
// user actually wrote.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'arbor-delivery': {
      kind: 'arbor-delivery'
    } & ContextFormed
  }
}

/**
 * The delivery kinds that say what changed under a window rather than what the
 * window should do about it.
 *
 * A prompt delta, a tools delta and an environment delta are all diffs of the
 * window's own context. They belong at the next step boundary of a running
 * window and in the next turn's prefix of a quiet one; neither is a reason to
 * start a turn.
 */
const DELTA_KINDS: ReadonlySet<Delivery['kind']> = new Set<Delivery['kind']>([
  'prompt_delta',
  'tools_delta',
  'environment_delta',
])

/** One model call's inputs, supplied by the DSH-side session agent. */
export interface DshModelCall {
  /** The window whose frozen epoch this call runs under. */
  readonly window: WindowRef
  /** The session agent whose log the request is derived from. */
  readonly agent: Agent
  readonly selection: Readonly<ModelSelection>
  readonly maxTokens?: number
  readonly position: { turn: number; step: number }
  readonly signal: AbortSignal
  /** One streamed chunk, for the durable attempt and the window's live output. */
  readonly onChunk: (chunk: StreamChunk) => void
}

/** One model call's settled facts. */
export interface DshModelOutcome {
  readonly usage?: TokenUsage
  readonly finish: string
}

/** Inputs for {@link createDshBackend}. */
export interface DshBackendOptions {
  /** DSH's LLM runtime (`ctx.llm`). */
  readonly llm: LlmRuntime
  /** DSH's tool registry (`ctx.tools`). */
  readonly tools: ToolsService
  /**
   * DSH's agent registry (`ctx.agents`). One backend serves every session, so
   * the agent a tool call runs as is read per call from the initiating agent of
   * the turn executing it — the same attribution DSH itself uses.
   */
  readonly agents: AgentRegistry
  /**
   * The host's one renderer, read lazily because the host is built after this
   * backend is. A delivery's blocks were built by the host with its own table
   * and block kinds, so rendering them with any other renderer would drop the
   * fixed lines and the kinds a plugin registered.
   */
  readonly renderer: () => Renderer
}

/** A minimal publish/subscribe bus for one window's events. */
class WindowEventBus {
  private readonly queues = new Set<{
    push: (event: WindowEvent) => void
    close: () => void
  }>()
  private closed = false

  publish(event: WindowEvent): void {
    if (this.closed) return
    for (const queue of [...this.queues]) queue.push(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const queue of [...this.queues]) queue.close()
    this.queues.clear()
  }

  subscribe(): AsyncIterable<WindowEvent> {
    const queues = this.queues
    const pending: WindowEvent[] = []
    const waiters: (() => void)[] = []
    let done = false
    const wake = (): void => {
      const next = waiters.shift()
      if (next !== undefined) next()
    }
    const queue = {
      push: (event: WindowEvent) => {
        pending.push(event)
        wake()
      },
      close: () => {
        done = true
        wake()
      },
    }
    this.queues.add(queue)
    return {
      [Symbol.asyncIterator](): AsyncIterator<WindowEvent> {
        return {
          async next(): Promise<IteratorResult<WindowEvent>> {
            while (true) {
              const event = pending.shift()
              if (event !== undefined) return { value: event, done: false }
              if (done) return { value: undefined as never, done: true }
              await new Promise<void>(resolve => { waiters.push(resolve) })
            }
          },
          async return(): Promise<IteratorResult<WindowEvent>> {
            queues.delete(queue)
            return { value: undefined as never, done: true }
          },
        }
      },
    }
  }
}

/** One running arbor window backed by a DSH session. */
class DshWindowSession implements WindowSession {
  readonly window: WindowRef
  private readonly bus: WindowEventBus
  private readonly ended = Promise.withResolvers<WindowOutcome>()
  private currentState: WindowState = 'running'
  private readonly usageValue = { used: 0, limit: 0, reserve: 0 }
  private readonly onEnd: () => void
  /** The window's frozen epoch, whose declared tools a `refreshTools` replaces. */
  private epoch: OpenWindowRequest | undefined
  /** The DSH session agent whose turns drive this window, once one is bound. */
  private driver: Agent | undefined
  /** How a delivery is rendered into the one user-role input the model reads. */
  private readonly render: (delivery: Delivery) => string

  constructor(window: WindowRef, bus: WindowEventBus, onEnd: () => void, render: (delivery: Delivery) => string) {
    this.window = window
    this.bus = bus
    this.onEnd = onEnd
    this.render = render
  }

  get state(): WindowState {
    return this.currentState
  }

  /** Capture the window's frozen epoch: its prompt, its declared tools, its limits. */
  open(request: OpenWindowRequest): void {
    this.epoch = request
    this.usageValue.limit = request.limits.contextTokens
    this.usageValue.reserve = request.limits.reserveTokens
  }

  /** Bind the DSH session agent whose turns drive this window. */
  bind(agent: Agent): void {
    this.driver = agent
  }

  /** Drop the binding, the way a session's disposal does. */
  unbind(): void {
    this.driver = undefined
  }

  /** One live event of this window, from the session agent that drives it. */
  publish(event: WindowEvent): void {
    if (this.currentState === 'ended') return
    this.bus.publish(event)
  }

  /**
   * Insert at the next tool-call boundary, through DSH's own steering.
   *
   * The mapping is the one arbor's `AgentBackend` contract names for a backend
   * that is not pi: `agent.inject` for a step boundary and the agent's steering
   * for the next turn. `agent.steer` covers both, because it splices into the
   * next step while a turn runs and starts one when the window is idle — which
   * is what a delivery arriving for a quiet window wants.
   */
  async steer(delivery: Delivery): Promise<void> {
    this.deliver(delivery, 'steer')
  }

  /** Queue for after the run ends: the delivery becomes the next turn's input. */
  async followUp(delivery: Delivery): Promise<void> {
    this.deliver(delivery, 'followUp')
  }

  private deliver(delivery: Delivery, how: 'steer' | 'followUp'): void {
    // The host never steers into a window it has ended or paused, and a window
    // whose session is not bound yet has no inbox to splice into: a restart
    // continuation opens before its session comes back.
    if (this.currentState !== 'running') return
    const agent = this.driver
    if (agent === undefined) return
    const text = this.render(delivery)
    if (text === '') return
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'arbor-delivery' },
    })
    // A delta is context for the window, not an input that deserves a turn of
    // its own: it says what changed under the window's feet, so it goes in at
    // the next step boundary and is never what starts a turn. Steering one into
    // a quiet window would wake that window's session to read a diff, which is
    // a turn the user did not ask for and the model has nothing to do in.
    if (how === 'steer' && DELTA_KINDS.has(delivery.kind)) agent.inject(message)
    else if (how === 'steer') agent.steer(message)
    else agent.followup(message)
  }

  /**
   * Replace the tools this window declared, so a tool that appeared is callable
   * here and one that was removed is not. The window's prefix is not rebuilt:
   * the `tools_delta` it is steered tells it what moved.
   */
  async refreshTools(tools: readonly DirectToolSpec[]): Promise<void> {
    if (this.epoch === undefined) return
    this.epoch = { ...this.epoch, tools }
  }

  /** The tools declared to the model for this window, as they stand now. */
  toolSpecs(): readonly DirectToolSpec[] {
    return this.epoch?.tools ?? []
  }

  /** The system prompt this window's epoch rendered. */
  systemPrompt(): string {
    return this.epoch?.prompt.system ?? ''
  }

  /**
   * Add one model call's tokens to the window's running total, and publish the
   * usage event.
   *
   * The event is what makes a running window current: the host asks every
   * plugin section's revision and re-reads the external tools on it, once per
   * step, so a `prompt_delta` and a `tools_delta` are delivered here rather than
   * never.
   */
  addUsage(usage: TokenUsage | undefined): void {
    if (usage === undefined) return
    this.usageValue.used += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    this.publish({ kind: 'usage', usage: { ...this.usageValue } })
  }

  async end(handoff?: Handoff, reason: WindowEndReason = 'model_ended'): Promise<void> {
    if (this.currentState === 'ended') return
    this.currentState = 'ended'
    const outcome = this.outcomeOf(reason, handoff)
    this.bus.publish({ kind: 'ended', outcome })
    this.bus.close()
    this.ended.resolve(outcome)
    this.onEnd()
  }

  async pause(): Promise<void> {
    this.currentState = 'paused'
  }

  async resume(): Promise<void> {
    this.currentState = 'running'
  }

  usage(): { used: number; limit: number; reserve: number } {
    return this.usageValue
  }

  events(): AsyncIterable<WindowEvent> {
    return this.bus.subscribe()
  }

  outcome(): Promise<WindowOutcome> {
    return this.ended.promise
  }

  private outcomeOf(reason: WindowEndReason, handoff?: Handoff): WindowOutcome {
    return {
      window: this.window,
      reason,
      ...handoff === undefined ? {} : { handoff },
      usage: this.usageValue,
    }
  }
}

/** One window's live session, and the session agent bound to it. */
interface WindowEntry {
  readonly session: DshWindowSession
  agent: Agent | undefined
}

/** What one session's request-header logging carries between calls. */
interface HeaderLog {
  logged: boolean
  toolNames: readonly string[]
}

/** The DSH-backed arbor agent backend: one per process, one entry per window. */
export class DshBackend implements AgentBackend {
  readonly name = 'dsh'
  private readonly windows = new Map<WindowRef, WindowEntry>()
  private readonly waiting = new Map<WindowRef, PromiseWithResolvers<void>>()
  private readonly headers = new WeakMap<Agent, HeaderLog>()

  private readonly options: DshBackendOptions

  constructor(options: DshBackendOptions) {
    this.options = options
  }

  /** Resolves once `open` has captured this window's frozen epoch. */
  whenOpen(window: WindowRef): Promise<void> {
    const waiting = this.waiting.get(window)
    if (waiting !== undefined) return waiting.promise
    const entry = this.windows.get(window)
    if (entry !== undefined) return Promise.resolve()
    const deferred = Promise.withResolvers<void>()
    this.waiting.set(window, deferred)
    return deferred.promise
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'dsh-session', provider: 'dsh', images: true, name: 'DSH session' }]
  }

  async login(): Promise<LoginResult> {
    return { provider: 'dsh', state: 'logged-in', models: await this.models() }
  }

  externalTools(): readonly ExternalTool[] {
    return dshExternalTools({
      tools: this.options.tools,
      agents: this.options.agents,
    })
  }

  /**
   * The names of the DSH tools this backend hands to arbor, for the
   * `<harness>` section's revision and its tool-usage lines. The same filter
   * {@link externalTools} applies, so a name here is a name the model can call.
   */
  externalToolNames(): readonly string[] {
    return this.externalTools().map(tool => tool.name).sort()
  }

  async open(request: OpenWindowRequest): Promise<WindowSession> {
    const bus = new WindowEventBus()
    const session = new DshWindowSession(
      request.window,
      bus,
      () => { this.release(request.window) },
      delivery => renderDelivery(delivery, this.options.renderer()),
    )
    session.open(request)
    this.windows.set(request.window, { session, agent: undefined })
    this.waiting.get(request.window)?.resolve()
    this.waiting.delete(request.window)
    return session
  }

  /**
   * Bind the DSH session agent whose turns drive this window. A window a
   * restart continued opens before its session is resumed, so the binding is
   * made when the session comes back, not when the window does.
   */
  bind(window: WindowRef, agent: Agent): void {
    const entry = this.windows.get(window)
    if (entry === undefined) return
    entry.agent = agent
    entry.session.bind(agent)
  }

  /**
   * Drop one window's binding, the way a session's disposal does: the window
   * itself is the host's and lives out arbor's own idle policy.
   */
  unbind(window: WindowRef): void {
    const entry = this.windows.get(window)
    if (entry === undefined) return
    entry.agent = undefined
    entry.session.unbind()
  }

  /** Drop one ended window's state, so nothing retains its agent or its bus. */
  private release(window: WindowRef): void {
    this.windows.delete(window)
    this.waiting.get(window)?.resolve()
    this.waiting.delete(window)
  }

  /** The window's live events, observable beside the host's own watch loop. */
  events(window: WindowRef): AsyncIterable<WindowEvent> {
    return this.requireEntry(window).session.events()
  }

  /** The system prompt this window's epoch rendered. */
  systemPrompt(window: WindowRef): string {
    return this.requireEntry(window).session.systemPrompt()
  }

  /** The direct tools declared to the model for this window, as they stand now. */
  toolSpecs(window: WindowRef): readonly DirectToolSpec[] {
    return this.requireEntry(window).session.toolSpecs()
  }

  /** Publish one live stream event to the window. */
  publish(window: WindowRef, event: WindowEvent): void {
    this.windows.get(window)?.session.publish(event)
  }

  /** The turn's work settled: the window's run ends and it stays open for more. */
  finishRun(window: WindowRef): void {
    const session = this.windows.get(window)?.session
    if (session === undefined || session.state === 'ended') return
    session.publish({
      kind: 'run_ended',
      outcome: { window, reason: 'model_ended', usage: session.usage() },
    })
  }

  /** End the window, the way a host shutdown does. */
  async endWindow(window: WindowRef, reason: WindowEndReason = 'host_restart'): Promise<void> {
    await this.windows.get(window)?.session.end(undefined, reason)
  }

  private requireEntry(window: WindowRef): WindowEntry {
    const entry = this.windows.get(window)
    if (entry === undefined) {
      throw new Error(`arbor backend: no open window "${window}"`)
    }
    return entry
  }

  /**
   * One model call for the DSH-side agent's current step: resolve the route,
   * log the request header, and stream through `ctx.llm`. The request's
   * messages come from the session log, exactly like the official loop's
   * `buildRequest`.
   */
  async modelCall(input: DshModelCall): Promise<DshModelOutcome> {
    const { agent } = input
    const llm = this.options.llm
    const { signal } = input
    const proposed = {
      provider: input.selection.provider,
      model: input.selection.model,
      ...input.selection.reasoningEffort === undefined ? {} : { reasoningEffort: input.selection.reasoningEffort },
      ...input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens },
    }
    const prepared: PreparedLlmCall = await llm.prepareCall(proposed, signal)
    signal.throwIfAborted()
    const config = prepared.config
    const tools = this.toolSpecs(input.window).map(schemaOf)
    this.logRequestHeader(agent, config, tools, input.position)
    const messages = agent.session.deriveMessages() as Message[]
    const request = markAgentLoopRequest({
      ...config,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...tools.length > 0 ? { tools: tools as unknown as ToolSchema[] } : {},
      sessionId: agent.session.id as SessionId,
      signal,
    })
    const assembler = new BlockAssembler()
    const stream = prepared.stream(request)
    for await (const chunk of stream) {
      signal.throwIfAborted()
      input.onChunk(chunk)
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    // The window's token total moves, which is also the host's cue to ask every
    // plugin section's revision and re-read the external tools: a prompt delta
    // and a tools delta are delivered on this event.
    this.windows.get(input.window)?.session.addUsage(assembler.usage)
    return { ...assembler.usage === undefined ? {} : { usage: assembler.usage }, finish: assembler.finish.kind }
  }

  /** Log the resolved request header the way `ReactLoopAgent.buildRequest` does. */
  private logRequestHeader(
    agent: Agent,
    config: LlmCallConfig,
    tools: readonly Record<string, unknown>[],
    position: { turn: number; step: number },
  ): void {
    const header = canonicalHeader({
      config,
      ...tools.length > 0 ? { tools: tools as never } : {},
    })
    const baseline = agent.session.requestHeader()
    const log = this.headers.get(agent)
    let headerSeq: SessionSeq | undefined
    if (log === undefined || !log.logged) {
      headerSeq = agent.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      }).seq
      this.headers.set(agent, { logged: true, toolNames: tools.map(tool => String(tool['name'])) })
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      headerSeq = agent.session.append('request/header', { header, reason: 'change' }).seq
      // The tool set is diffed against the previous header rather than against
      // this process's own record of it, so a window a restart continued reports
      // the same additions the log already implies. Without that, the second
      // process's first change would re-report tools the first one added.
      const previousNames = new Set((baseline?.tools ?? []).map(tool => String(tool.name)))
      const currentNames = new Set(tools.map(tool => String(tool['name'])))
      const additions = [...currentNames].filter(name => !previousNames.has(name))
        .map(name => ({ type: 'tool-addition' as const, toolName: name }))
      const removals = [...previousNames].filter(name => !currentNames.has(name))
        .map(name => ({ type: 'tool-removal' as const, toolName: name }))
      if (additions.length > 0 || removals.length > 0) {
        // A `developer/message` that activates a tool must name the header that
        // declares it, which is the one just appended: DSH's own append refuses
        // the event otherwise, and the refusal lands on the turn that asked for
        // the model call.
        agent.session.append('developer/message', {
          ...position,
          message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          ...additions.length > 0 ? { headerSeq } : {},
        }, { surfaceOp: 'append' })
      }
      this.headers.set(agent, { logged: true, toolNames: tools.map(tool => String(tool['name'])) })
    }
  }
}

/** Create the DSH-backed arbor agent backend. */
export function createDshBackend(options: DshBackendOptions): DshBackend {
  return new DshBackend(options)
}
