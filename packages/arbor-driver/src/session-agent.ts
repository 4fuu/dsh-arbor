/**
 * The arbor session agent: one DSH user session driven through one arbor
 * window.
 *
 * It implements the full `Agent` contract that
 * `packages/core/agent/src/runtime-types.ts` augments onto `Agent` — the same
 * surface `ReactLoopAgent` implements — but the model call and every tool call
 * run through the arbor window instead of the in-process loop:
 *
 *  - `followup()`/`steer()`/`inject()` splice the durable inbox and wake the
 *    driver, exactly like the official loop (inbox.ts in dsh-agent-loop).
 *  - The driver runs turns and steps over the arbor window: `turn/start`,
 *    `step/start`, `user/message`, streamed `agent/assistant-stream` frames,
 *    `assistant/message`, `ctx.tools.execute` through arbor's tool path,
 *    `step/end`, `agent/turn-stopping`, `turn/end`.
 *  - Model requests are derived from the session log (`session.deriveMessages()`)
 *    exactly like `ReactLoopAgent.buildRequest`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  ModelSelection,
  ModelSelectionProjectionState,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { AgentModel, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { InboxState } from '@deepseek-ai/dsh-agent'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createSystemMessage, errorChain, LlmError } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { snapshotContextNames } from '@4fu/dsh-arbor-prompt'
import type { ToolResult, WindowEvent } from '@4fu/arbor-interfaces'
import type { WindowRef } from '@4fu/arbor-interfaces'
import { ArborInbox } from './inbox.ts'
import { ArborStreamAttempt } from './assistant-stream.ts'
import { RuntimeContextProjection } from './runtime-context.ts'

/** One model call's inputs, supplied by the DSH-side session agent. */
export interface ModelCallInput {
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
export interface ModelCallOutcome {
  readonly usage?: TokenUsage
  readonly finish: string
}

/**
 * The arbor window this session drives. Implemented by the driver, which owns
 * the Arbor host; the agent never imports arbor-core directly. Every method
 * that touches the window takes its ref, because the session's window changes
 * over its life: arbor ends a window that goes quiet and the next turn drives
 * the window that follows it.
 */
export interface ArborWindowBridge {
  /** Open the window on first use and return its ref. */
  ensureWindow(request?: string): Promise<WindowRef>
  /** The system prompt rendered for this window's epoch. */
  systemPrompt(window: WindowRef): string
  /** One model call through DSH's `ctx.llm`. */
  modelCall(input: ModelCallInput): Promise<ModelCallOutcome>
  /** Run one model-produced tool call through arbor's tool path into `ctx.tools.execute`. */
  runToolCall(call: ToolCallBlock, position: { turn: number; step: number }): Promise<ToolResult>
  /** Publish one window event to the arbor window. */
  publish(window: WindowRef, event: WindowEvent): void
  /** Write a step's sends after its tool results have been appended. */
  flushSends(): void
  /** The turn's work settled: the window's run ends and it goes idle. */
  finishRun(window: WindowRef): void
  /** Release the session's hold on its window. */
  close(): Promise<void>
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Whether this session's log already carries the system prompt it opened with. */
function hasSystemMessage(session: Session): boolean {
  for (let seq = 0; seq < session.seq; seq++) {
    if (session.eventAt(seq as never)?.type === 'system/message') return true
  }
  return false
}

/** Read the cause `cancel()` passed when aborting a loop-owned signal. */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    default:
      return { kind: 'user' }
  }
}

/** One DSH session driven through one arbor window. */
export class ArborSessionAgent implements Agent {
  readonly model: AgentModel
  readonly inbox: ArborInbox
  readonly scope: Scope
  readonly ctx: Context
  private readonly dispatch: AgentEventDispatch
  private bridge!: ArborWindowBridge
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private systemPromptLogged = false

  private readonly loopCtx: Context
  public readonly id: SessionId
  public readonly options: AgentOptions
  public readonly session: Session
  /** The window the live step drives, so the turn can end its run. */
  private currentWindow: WindowRef | undefined
  /**
   * The session's runtime-context snapshot: the working directory and any
   * third-party runtime context, appended when it changes and never rewritten
   * into the frozen prefix.
   */
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    projections: {
      readonly modelSelection: () => ModelSelectionProjectionState
      readonly inbox: () => InboxState
    },
    lastTurn: number,
  ) {
    this.loopCtx = loopCtx
    this.id = id
    this.options = options
    this.session = session
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.model = new AgentModel(projections.modelSelection, session, options)
    this.inbox = new ArborInbox(projections.inbox, session, this.dispatch)
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    // A session resumed from its log already carries the system prompt it
    // opened with, exactly like the official loop's in-history projection.
    this.systemPromptLogged = hasSystemMessage(session)
  }

  /** Attach the arbor window bridge; the driver calls this once the host exists. */
  attachBridge(bridge: ArborWindowBridge): void {
    this.bridge = bridge
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** The turn/step position the live model step logs its tool events at. */
  currentLogPosition(): { turn: number; step: number } | undefined {
    return this.phase.kind === 'running' ? { turn: this.phase.turn, step: this.phase.step } : undefined
  }

  /** The live turn's abort signal, for tool execution. */
  currentSignal(): AbortSignal | undefined {
    return this.phase.kind === 'running' ? this.phase.abort.signal : undefined
  }

  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) this.dispatch.emit('agent/status', { status })
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({ kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) { /* the next queued turn runs in the same driver */ }
    } catch {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const claimed = this.inbox.claim(target, turn)
        const selection = this.model.current()
        if (selection === undefined) {
          throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and model or record a model selection`)
        }
        // `agent/pre-step` is dispatched every step, exactly like the official
        // loop, and a decision's messages are the ones this step admits: a hook
        // that rewrites them is honored. Only `reject` ends the turn early.
        // The fallback is the official loop's own: it appends the runtime
        // context its projection assembled — a third party's per-session
        // context, which a section frozen per epoch cannot state. A hook that
        // rewrites the messages replaces it, exactly like the official loop.
        const decision = await this.dispatch.waterfall(
          'agent/pre-step',
          { messages: claimed, turn, step, signal, modelSelection: selection },
          async (): Promise<PreStepDecision> => {
            const snapshot = await this.runtimeContextSnapshot(signal)
            return { kind: 'enter', messages: snapshot === undefined ? claimed : [...claimed, snapshot] }
          },
        )
        signal.throwIfAborted()
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          const stepEnd = await this.step(decision.messages, turn, step, selection, signal)
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
      // The window's run ends with the turn; it stays open for the next one.
      const ended = this.currentWindow
      this.currentWindow = undefined
      if (ended !== undefined) this.bridge.finishRun(ended)
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * The session's runtime-context snapshot for this step, or `undefined` when
   * nothing changed since the last one.
   *
   * DSH's own assembly supplies the text, so the wording stays DSH's: the
   * snapshot is the one the official loop would have appended for this session.
   * Only a third party's context is carried — the paths are arbor's own
   * `<workspace>` section's, and the policies are `<harness>`'s.
   */
  private async runtimeContextSnapshot(signal: AbortSignal): Promise<UserMessage | undefined> {
    let assembly: PromptAssembly
    try {
      assembly = await this.loopCtx.systemPrompt.assemble({
        ...assembleContextFor(this, signal),
        ...this.model.current() === undefined ? {} : { modelSelection: this.model.current() },
      })
    } catch (error: unknown) {
      // The assembly runs DSH's own providers, and one of them — the tool
      // presentation row — resolves a tool executor in this agent's scope and
      // throws when none is registered there. The arbor path executes its tools
      // through `ctx.tools.execute` and never mounts DSH's executor, so that
      // provider has nothing to describe. A snapshot is the one thing the
      // pre-step fallback adds, and losing it costs the model a third party's
      // runtime context for one step; losing the turn costs it the step.
      this.ctx.logger.warn(`arbor driver: the runtime-context snapshot was skipped: ${errorChain(error)}`)
      return undefined
    }
    const carried = new Set(snapshotContextNames(assembly))
    const sections = renderContextSections(assembly).filter(section => carried.has(section.name))
    return this.runtimeContext.project(joinContextSections(sections))
  }

  /** One model call plus the tool executions it requested. */
  private async step(
    messages: readonly UserMessage[],
    turn: number,
    step: number,
    selection: Readonly<ModelSelection>,
    signal: AbortSignal,
  ): Promise<Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }> | null> {
    signal.throwIfAborted()
    const request = messages
      .filter(message => message.source?.kind === 'user')
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const window = await this.bridge.ensureWindow(request === '' ? undefined : request)
    this.currentWindow = window
    // The system prompt the window's epoch rendered, admitted once per session:
    // a session resumed from its log already carries the one it opened with.
    if (!this.systemPromptLogged) {
      const system = this.bridge.systemPrompt(window)
      if (system.length > 0) {
        this.session.append('system/message', {
          turn,
          step,
          message: createSystemMessage(system),
        }, { surfaceOp: 'append' })
      }
      this.systemPromptLogged = true
    }
    for (const message of messages) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
    const config = {
      ...selection,
      ...this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens },
    }
    const attempt = new ArborStreamAttempt(
      this.session.id,
      ++this.assistantAttemptCounter,
      () => ++this.assistantStreamRevision,
      turn,
      step,
      (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
    )
    attempt.start()
    try {
      await this.bridge.modelCall({
        window,
        agent: this,
        selection,
        ...this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens },
        position: { turn, step },
        signal,
        onChunk: (chunk) => {
          attempt.push(chunk)
          if (chunk.type === 'text-delta') {
            this.bridge.publish(window, { kind: 'text_delta', delta: chunk.text })
          }
        },
      })
    } catch (error: unknown) {
      if (!attempt.ended) {
        if (signal.aborted) {
          const content = attempt.interruptedBlocks()
          if (content.length > 0) {
            attempt.settle('assistant/message', () => this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: config.provider, model: config.model },
              }),
              interrupted: true,
              ...attempt.usage === undefined ? {} : { usage: attempt.usage },
              stream: attempt.stream,
            }, { surfaceOp: 'append' }).seq)
          } else {
            attempt.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: attempt.stream }).seq)
          }
        } else {
          attempt.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: attempt.stream }).seq)
        }
      }
      throw error
    }
    const message = createAssistantMessage({
      content: attempt.blocks(),
      source: {
        provider: config.provider,
        model: config.model,
        ...attempt.replayState === undefined ? {} : { replayState: attempt.replayState as never },
      },
    })
    attempt.settle('assistant/message', () => this.session.append('assistant/message', {
      turn,
      step,
      message,
      ...attempt.usage === undefined ? {} : { usage: attempt.usage },
      stream: attempt.stream,
    }, { surfaceOp: 'append' }).seq)
    if (attempt.finish.kind === 'max-tokens') return { kind: 'max-tokens' }
    const toolCalls = message.content.filter(block => block.type === 'tool-call')
    if (toolCalls.length === 0) return { kind: 'completed' }
    try {
      for (const block of toolCalls) {
        if (block.type !== 'tool-call') continue
        const result = await this.bridge.runToolCall(block, { turn, step })
        const call = { name: block.name, args: safeParseArgs(block.arguments), callId: block.id }
        this.bridge.publish(window, { kind: 'tool_call', call })
        this.bridge.publish(window, { kind: 'tool_result', call, result })
      }
    } finally {
      // Every tool result of this step is on the log now; a send's assistant
      // message belongs after them and before the step closes.
      this.bridge.flushSends()
    }
    return null
  }
}

/** Parse a model-produced arguments string; invalid JSON becomes an empty object. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
