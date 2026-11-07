/**
 * The per-session runtime-context snapshot.
 *
 * Arbor's system prompt is frozen per epoch and shared by every window of that
 * epoch, so a fact that belongs to one session cannot be written into a section:
 * a section would tell every other session in the epoch the wrong value. The
 * official loop solves the same problem with a snapshot message it appends at
 * every step and replaces when it changes
 * (`@deepseek-ai/dsh-agent-loop` RuntimeContextProjection), and this is that
 * projection for the arbor path: the same source kind, the same "none" line,
 * and the same rule that a message which is not exactly one text block is never
 * treated as a retained snapshot, so a snapshot a window received before a
 * restart is recognised as one on replay.
 *
 * What it carries is deliberately narrow — see
 * {@link snapshotContextNames} in `@4fu/dsh-arbor-prompt`. Only a third party's
 * runtime context travels here, because nothing else can carry per-session
 * state from outside the framework. The approval policy and plan mode are
 * written into the `<harness>` section instead, in dsh-arbor's own wording, and
 * reach a running window as a `prompt_delta` carrying only the changed lines;
 * the paths are arbor's own `<workspace>` section's.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'

// The source kind DSH's own loop marks a runtime-context snapshot with. The
// declaration lives in `@deepseek-ai/dsh-agent-loop`'s unexported
// `runtime-context` types, so a consumer of the seam restates it here rather
// than reaching into a package's private module.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': {
      kind: 'runtime-context'
    } & ContextFormed
  }
}
/** The fixed text an empty snapshot carries, so a cleared one supersedes too. */
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** Whether one message is a snapshot this projection owns. */
function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'runtime-context'
}

/** The text of a message that is exactly one text block, else `undefined`. */
function textOf(message: UserMessage): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** Whether one event replaces a surface node the retained snapshot lives in. */
function isReplacementSurfaceEvent(event: { type: string; sourceEventSeqs?: readonly SessionSeq[] }): boolean {
  return event.type === 'system/message' || event.type === 'user/message'
}

/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; text: string } | null | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context
   * @param session - session receiving projected messages
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of session.snapshotEvents().toReversed()) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) ?? '' }
        break
      }
    }
    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) ?? '' }
      } else if (this.retained && isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context
   * @returns a candidate user message, or `undefined` when no update is needed
   */
  project(current: string): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: { kind: 'runtime-context' },
    })
  }
}
