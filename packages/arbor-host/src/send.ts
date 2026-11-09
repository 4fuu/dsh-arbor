/**
 * The `send` executor: what a window sends reaches the DSH user.
 *
 * Arbor's `send` records an effect and hands it to the queue, which carries it
 * out only when an executor owns it. Nothing in arbor's core knows about DSH,
 * so without this module every send a window makes stays queued forever and the
 * window's own result line — `已记录 r4，效果已入队。` — is the last anyone hears
 * of it. That is the honest answer for a target nobody owns, and the wrong one
 * for the target this deployment exists to serve: the DSH user, who sees only
 * what `send` writes.
 *
 * So this executor owns the DSH targets and lands their content on the session
 * log as an assistant message, which is the surface DSH's client renders — the
 * same one the official agent loop writes the model's reply to. The markdown
 * link syntax `<harness>` states (`![说明](<绝对路径>)`, `[文件名](<路径#L24>)`)
 * is DSH's own `ui:deliverable-file-references` wording, so a link written that
 * way renders the way DSH renders any assistant message.
 *
 * Two target forms are owned:
 *
 *  - `dsh:user` — the user of the session that sent it. The session is read back
 *    from the journal, the same way the workspace reads it, so a send made
 *    after its turn ended still lands on the right session's log.
 *  - `dsh:session:<id>` — one named session's user, for a window that addresses
 *    another session directly.
 *
 * Every other target stays unowned, which is arbor's own answer for a channel
 * nobody plugged in: the effect is recorded, the queue waits, and the window is
 * told the effect is queued rather than delivered.
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Effect, EffectExecutor, EffectResult, Journal, WindowRef } from '@4fu/arbor-interfaces'
import { MAX_PAGE_LIMIT } from '@4fu/arbor-interfaces'
import { SESSION_TARGET_PREFIX } from './index.ts'

/** The target prefix every DSH target carries. */
export const DSH_TARGET_PREFIX = 'dsh:'

/** The target that names the DSH user of the session that sent. */
export const DSH_USER_TARGET = 'dsh:user'

/** Inputs for {@link DshSendExecutor}. */
export interface DshSendExecutorOptions {
  /** The journal, to read which DSH session one window belongs to. */
  readonly journal: Journal
  /** DSH's agent registry, to reach a session's log by its id. */
  readonly agents: AgentRegistry
}

/**
 * Carries a window's `send` out onto the DSH session log.
 *
 * The append happens while the turn that made the send is still in flight —
 * `EffectQueue.submit` starts the drain before it returns — so the message the
 * user reads appears beside the tool call that produced it rather than after
 * the turn. The turn and step are read off the log rather than passed in, so a
 * send made outside any turn (a restart's replay, a scheduled task) still lands
 * at a position the log accepts.
 */
export class DshSendExecutor implements EffectExecutor {
  readonly id = 'dsh-send'

  private readonly journal: Journal
  private readonly agents: AgentRegistry

  constructor(options: DshSendExecutorOptions) {
    this.journal = options.journal
    this.agents = options.agents
  }

  can(effect: Effect): boolean {
    return effect.kind === 'send' && effect.target.startsWith(DSH_TARGET_PREFIX)
  }

  async run(effect: Effect): Promise<EffectResult> {
    const text = sendText(effect)
    if (text === '') {
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          rule: 'send.content.empty',
          message: 'dsh-arbor: a send carried no text',
          nextAction: '补上要发送的内容，然后重发。',
        },
      }
    }
    const agent = await this.agentOf(effect)
    if (agent === undefined) {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          rule: 'send.session.absent',
          message: `dsh-arbor: no DSH session owns the window that sent to ${effect.target}`,
          nextAction: '确认这个窗口还属于一个存活的 DSH 会话，然后重发。',
        },
      }
    }
    agent.session.append('assistant/message', {
      ...positionOf(agent.session),
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: attributionOf(agent),
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    return { ok: true }
  }

  /**
   * The DSH agent one effect addresses.
   *
   * A `dsh:session:<id>` target names it directly. `dsh:user` asks which
   * session the sending window belongs to, which the journal records on the
   * window's own `window_start` event — the same record the workspace reads for
   * a window's root, so the two answers cannot disagree.
   */
  private async agentOf(effect: Effect): Promise<Agent | undefined> {
    if (effect.target !== DSH_USER_TARGET && effect.target.startsWith(SESSION_TARGET_PREFIX)) {
      const named = effect.target.slice(SESSION_TARGET_PREFIX.length)
      return this.agents.get(named as SessionId)
    }
    const window = await this.windowSession(effect.madeBy)
    return window === undefined ? undefined : this.agents.get(window)
  }

  /** The DSH session one window belongs to, from the journal's own record. */
  private async windowSession(window: WindowRef): Promise<SessionId | undefined> {
    for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
      const page = await this.journal.list({ window, kinds: ['window_start'], limit: MAX_PAGE_LIMIT, offset })
      for (const event of page.items) {
        // The label is the deployment's own attachment - the DSH session id -
        // carried by arbor onto the window's start. A journal written before
        // labels carries the session as a target instead.
        if (event.body !== null) {
          try {
            const parsed: unknown = JSON.parse(event.body)
            const label = (parsed as { label?: unknown } | null)?.label
            if (typeof label === 'string' && label !== '') return label as SessionId
          } catch {
            // A body that is not JSON names no label.
          }
        }
        const target = event.targets.find(one => one.startsWith(SESSION_TARGET_PREFIX))
        if (target !== undefined) return target.slice(SESSION_TARGET_PREFIX.length) as SessionId
      }
      if (page.items.length < MAX_PAGE_LIMIT) return undefined
    }
  }
}

/**
 * The text one `send` effect carries.
 *
 * The host wraps a send's content in a `data` block whose `content` field is
 * the string the model wrote, so the text is that field rather than the block's
 * rendered form.
 */
function sendText(effect: Effect): string {
  const value = effect.content[0]?.fields['content']
  return typeof value === 'string' ? value : ''
}

/**
 * The turn and step a send lands at.
 *
 * The newest `step/start` on the log, so the message joins the step that asked
 * for it. A log with no step yet — a send made before any turn — lands at 0:0,
 * which is where the loop puts the session's first system prompt.
 */
function positionOf(session: Session): { turn: number; step: number } {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
  }
  return { turn: 0, step: 0 }
}

/**
 * Who the sent message is attributed to.
 *
 * The session agent's own model selection, so the message reads as this
 * session's model having said it — the same attribution the official loop
 * writes. An agent with no selection yet (a send before the first model call)
 * is attributed to arbor, which is the driver that produced it.
 */
function attributionOf(agent: Agent): { provider: string; model: string } {
  const selection = agent.model.current()
  return {
    provider: selection?.provider ?? 'arbor',
    model: selection?.model ?? 'arbor',
  }
}
