/**
 * Process-local assistant attempt framing for arbor sessions.
 *
 * A compact mirror of `packages/core/agent-loop/src/assistant-stream.ts`
 * (AssistantStreamAttempt): the same dsh-llm primitives
 * (`AssistantStreamAccumulator`, `BlockAssembler`), the same frame order
 * (start, chunk*, end), and the same settlement contract — the durable
 * `assistant/message` or `assistant/attempt` append commits BEFORE the
 * terminal frame is emitted.
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Folds one model attempt into one compact stream plus ordered transient frames. */
export class ArborStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private index = 0
  private terminal = false
  readonly attemptId: LlmAttemptId

  private readonly nextRevision: () => number
  readonly turn: number
  readonly step: number
  private readonly emit: (frame: AssistantStreamFrame) => void

  constructor(
    sessionId: SessionId,
    attempt: number,
    nextRevision: () => number,
    turn: number,
    step: number,
    emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.nextRevision = nextRevision
    this.turn = turn
    this.step = step
    this.emit = emit
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  get ended(): boolean {
    return this.terminal
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({ type: 'start', attemptId: this.attemptId, revision: this.nextRevision(), turn: this.turn, step: this.step })
  }

  /** Snapshot one chunk once, then feed durable compaction, assembly, and live publication. */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /** Publish terminal settlement after the matching durable event commits. */
  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** Publish abandonment when no durable attempt event can be committed. */
  abandon(): void {
    this.terminal = true
    this.emit({ type: 'end', attemptId: this.attemptId, revision: this.nextRevision(), index: this.index, outcome: { kind: 'abandoned' } })
  }

  /** Exact compact stream for the final durable event. */
  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** Canonical completed-message blocks from the same chunks. */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /** Safe visible prefix when cancellation interrupts the attempt. */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }

  /** Latest adapter-reported usage in the stream. */
  get usage(): TokenUsage | undefined {
    return this.assembler.usage
  }

  /** Terminal reason, defaulting to stop when the stream omitted one. */
  get finish(): FinishReason {
    return this.assembler.finish
  }

  /** Replay state carried by the terminal finish record. */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembler.replayState
  }
}
