/**
 * The arbor `AgentBackend` that runs each window through DSH.
 *
 * This is the seam where arbor's window lifecycle meets DSH's services:
 *
 *  - `open(request)` captures the window's frozen epoch (the rendered system
 *    prompt and the declared direct tools, DSH's among them) and returns the
 *    window session the host watches.
 *  - `modelCall` — used by the DSH-side session agent for each of its steps —
 *    resolves the route, logs the `request/header`, and streams through
 *    `ctx.llm.stream`; the request itself is derived from the session log by
 *    the agent's owner (this backend reads `session.deriveMessages()`).
 *  - `externalTools()` hands DSH's registered tools to arbor, so the model
 *    declares and calls them like any other direct tool; execution lands back
 *    in `ctx.tools.execute` with the user session's agent, which is what
 *    routes approvals through DSH's approval path.
 *
 * The window session is a live event bus: the agent publishes text deltas,
 * tool calls and run boundaries, and the host's `watch` loop consumes them
 * like any backend's.
 */

import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, PreparedLlmCall, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createDeveloperMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
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
import { schemaOf } from '@4fu/dsh-arbor-tools'

/** One model call's inputs, supplied by the DSH-side session agent. */
export interface DshModelCall {
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
  /** The DSH session agent this window belongs to. */
  readonly agent: Agent
  /** DSH's LLM runtime (`ctx.llm`). */
  readonly llm: LlmRuntime
  /** DSH's registered tools, as arbor external tools. */
  readonly externalTools: () => readonly ExternalTool[]
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
  private readonly bus = new WindowEventBus()
  private readonly ended = Promise.withResolvers<WindowOutcome>()
  private currentState: WindowState = 'running'
  private readonly usageValue = { used: 0, limit: 0, reserve: 0 }
  private readonly queued: Delivery[] = []

  constructor(window: WindowRef) {
    this.window = window
  }

  get state(): WindowState {
    return this.currentState
  }

  publish(event: WindowEvent): void {
    this.bus.publish(event)
  }

  async steer(delivery: Delivery): Promise<void> {
    this.queued.push(delivery)
  }

  async followUp(delivery: Delivery): Promise<void> {
    this.queued.push(delivery)
  }

  async end(handoff?: Handoff, reason: WindowEndReason = 'model_ended'): Promise<void> {
    if (this.currentState === 'ended') return
    this.currentState = 'ended'
    const outcome = this.outcomeOf(reason, handoff)
    this.bus.publish({ kind: 'ended', outcome })
    this.bus.close()
    this.ended.resolve(outcome)
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

/** The DSH-backed arbor agent backend. */
export class DshBackend implements AgentBackend {
  readonly name = 'dsh'
  private session: DshWindowSession | undefined
  private request: OpenWindowRequest | undefined
  private requestHeaderLogged = false
  private loggedToolNames: readonly string[] = []
  private readonly opened = Promise.withResolvers<void>()

  private readonly options: DshBackendOptions

  constructor(options: DshBackendOptions) {
    this.options = options
  }

  /** Resolves once `open` has captured this window's frozen epoch. */
  whenOpen(): Promise<void> {
    return this.opened.promise
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'dsh-session', provider: 'dsh', images: true, name: 'DSH session' }]
  }

  async login(): Promise<LoginResult> {
    return { provider: 'dsh', state: 'logged-in', models: await this.models() }
  }

  externalTools(): readonly ExternalTool[] {
    return this.options.externalTools()
  }

  async open(request: OpenWindowRequest): Promise<WindowSession> {
    this.request = request
    const session = new DshWindowSession(request.window)
    this.session = session
    this.opened.resolve()
    return session
  }

  /** The system prompt this window's epoch rendered. */
  systemPrompt(): string {
    return this.request?.prompt.system ?? ''
  }

  /** The direct tools declared to the model for this window. */
  toolSpecs(): readonly DirectToolSpec[] {
    return this.request?.tools ?? []
  }

  /** Publish one live stream event to the window. */
  publish(event: WindowEvent): void {
    this.session?.publish(event)
  }

  /** The turn's work settled: the window's run ends and it stays open for more. */
  finishRun(): void {
    const session = this.session
    if (session === undefined || session.state === 'ended') return
    session.publish({
      kind: 'run_ended',
      outcome: { window: session.window, reason: 'model_ended', usage: session.usage() },
    })
  }

  /** End the window, the way a host shutdown does. */
  async endWindow(reason: WindowEndReason = 'host_restart'): Promise<void> {
    await this.session?.end(undefined, reason)
  }

  /** The live window session, for the driver's bridge. */
  get live(): DshWindowSession | undefined {
    return this.session
  }

  /**
   * One model call for the DSH-side agent's current step: resolve the route,
   * log the request header, and stream through `ctx.llm`. The request's
   * messages come from the session log, exactly like the official loop's
   * `buildRequest`.
   */
  async modelCall(input: DshModelCall): Promise<DshModelOutcome> {
    const { agent, llm } = this.options
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
    const tools = this.toolSpecs().map(schemaOf)
    this.logRequestHeader(config, tools, input.position)
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
    return { ...assembler.usage === undefined ? {} : { usage: assembler.usage }, finish: assembler.finish.kind }
  }

  /** Log the resolved request header the way `ReactLoopAgent.buildRequest` does. */
  private logRequestHeader(
    config: LlmCallConfig,
    tools: readonly Record<string, unknown>[],
    position: { turn: number; step: number },
  ): void {
    const { agent } = this.options
    const header = canonicalHeader({
      config,
      ...tools.length > 0 ? { tools: tools as never } : {},
    })
    const baseline = agent.session.requestHeader()
    if (!this.requestHeaderLogged) {
      agent.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      })
      this.requestHeaderLogged = true
      this.loggedToolNames = tools.map(tool => String(tool['name']))
      return
    }
    if (baseline === undefined || !headerEquals(baseline, header)) {
      agent.session.append('request/header', { header, reason: 'change' })
      if (baseline !== undefined) {
        const previousNames = new Set(this.loggedToolNames)
        const currentNames = new Set(tools.map(tool => String(tool['name'])))
        const additions = [...currentNames].filter(name => !previousNames.has(name))
          .map(name => ({ type: 'tool-addition' as const, toolName: name }))
        const removals = [...previousNames].filter(name => !currentNames.has(name))
          .map(name => ({ type: 'tool-removal' as const, toolName: name }))
        if (additions.length > 0 || removals.length > 0) {
          agent.session.append('developer/message', {
            ...position,
            message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          }, { surfaceOp: 'append' })
        }
      }
      this.loggedToolNames = tools.map(tool => String(tool['name']))
    }
  }
}

/** Create the DSH-backed arbor agent backend. */
export function createDshBackend(options: DshBackendOptions): DshBackend {
  return new DshBackend(options)
}
