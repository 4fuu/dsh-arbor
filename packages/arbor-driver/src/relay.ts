/**
 * The relay: arbor's journal onto the DSH session log.
 *
 * A window's own record lives in the arbor journal, and the user-visible one
 * lives in the DSH session log. The driver mirrors the second from the first:
 * while a turn runs, every tool call is recorded in the journal before it runs
 * and its result after, and DSH appends the matching `tool/call` +
 * `tool/result` pair to the session log. A process that stops in between
 * leaves the journal holding a call the log never saw.
 *
 * On resume the relay reads the session's window chain out of the journal and
 * appends the `tool/call` events the log is missing, so DSH's own
 * `interruptedTurnClosers` can then close them with an outcome-unknown result
 * instead of a not-started one — the model is told the call may have had side
 * effects, which is the truth.
 *
 * The cursor is the DSH session log itself: the journal's calls are matched,
 * in order, against the calls the log's assistant messages asked for, and
 * whatever the log already carries is left alone. There is no second cursor to
 * keep in step, and nothing is replayed twice.
 */

import { isDeepStrictEqual } from 'node:util'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { EventRef, Journal, WindowRef } from '@4fu/arbor-interfaces'
import { MAX_PAGE_LIMIT } from '@4fu/arbor-interfaces'

/** One tool call the arbor window recorded, read back from the journal. */
export interface ArborToolCall {
  /** The tool the window called. */
  readonly name: string
  /** The arguments as the journal recorded them. */
  readonly args: string
  /** Whether the window recorded this call's result as well. */
  readonly settled: boolean
}

/** One tool call the session's assistant messages asked for. */
interface AskedCall {
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: string
  readonly turn: number
  readonly step: number
}

/** Split a journal `tool_call` body (`name {args}`) into its two parts. */
function splitCall(body: string): { name: string; args: string } | undefined {
  const at = body.indexOf(' ')
  if (at <= 0) return undefined
  return { name: body.slice(0, at), args: body.slice(at + 1) }
}

/** Whether two argument strings carry the same JSON value. */
function sameArgs(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right))
  } catch {
    return false
  }
}

/**
 * The tool calls one window chain recorded, in journal order.
 *
 * The chain is every window of one session: the first, its continuations, and
 * the one a restart opened for it. A `tool_result` names the `tool_call` it
 * answers in its refs, which is how a call is known to be settled.
 */
export async function windowToolCalls(
  journal: Journal,
  windows: readonly WindowRef[],
): Promise<ArborToolCall[]> {
  const chain = new Set<WindowRef>(windows)
  const calls: { name: string; args: string; settled: boolean }[] = []
  const index = new Map<EventRef, number>()
  for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
    const page = await journal.list({ kinds: ['tool_call', 'tool_result'], limit: MAX_PAGE_LIMIT, offset })
    for (const event of page.items) {
      if (event.window === null || !chain.has(event.window)) continue
      if (event.kind === 'tool_call') {
        const split = splitCall(event.body ?? '')
        if (split === undefined) continue
        index.set(event.ref, calls.length)
        calls.push({ ...split, settled: false })
        continue
      }
      const answered = event.refs[0] as EventRef | undefined
      if (answered === undefined) continue
      const at = index.get(answered)
      if (at !== undefined) calls[at] = { ...calls[at], settled: true }
    }
    if (page.items.length < MAX_PAGE_LIMIT) break
  }
  return calls
}

/**
 * The `tool/call` events the arbor journal recorded and this log lost.
 *
 * Arbor runs the calls it recorded, in order, so they are the prefix of the
 * calls the log's assistant messages asked for; a mismatch stops the replay
 * rather than guessing. Calls the log already answers, and calls an
 * interrupted attempt left behind (which arbor never ran), are left out.
 */
export function relayToolCalls(
  log: readonly SessionEvent[],
  calls: readonly ArborToolCall[],
): Extract<SessionEvent, { type: 'tool/call' }>[] {
  const asked: AskedCall[] = []
  const answered = new Set<string>()
  for (const event of log) {
    switch (event.type) {
      case 'assistant/message':
        // An interrupted attempt's blocks were never run, so they are not part
        // of the order arbor's calls follow.
        if (event.data.interrupted === true) break
        for (const block of event.data.message.content) {
          if (block.type !== 'tool-call') continue
          asked.push({
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
            turn: event.data.turn,
            step: event.data.step,
          })
        }
        break
      case 'tool/result':
        answered.add(event.data.message.toolCallId)
        break
      default:
        break
    }
  }
  const last = log.at(-1)
  const relayed: Extract<SessionEvent, { type: 'tool/call' }>[] = []
  let seq = last?.seq ?? 0
  const time = last?.time ?? Date.now()
  for (const [position, call] of calls.entries()) {
    const wanted = asked[position]
    if (wanted === undefined) break
    if (wanted.name !== call.name || !sameArgs(wanted.arguments, call.args)) break
    if (answered.has(wanted.callId)) continue
    const data: SessionEventMap['tool/call'] = {
      turn: wanted.turn,
      step: wanted.step,
      callId: wanted.callId,
      name: wanted.name,
      arguments: wanted.arguments,
    }
    seq += 1
    relayed.push({ type: 'tool/call', seq: SessionSeq(seq), time, data })
  }
  return relayed
}
