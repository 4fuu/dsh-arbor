/**
 * Proof 4: a tool call that needs approval reaches DSH's approval path.
 *
 * The scripted model calls `spike_ask`, a test tool whose pre-execute
 * waterfall answers `{ kind: 'ask' }`. The call runs through arbor's tool
 * path (`windowControl().runToolCall` → the tool bridge → `ctx.tools.execute`
 * with the user session's agent), so DSH's own pipeline resolves the ask:
 *
 *   packages/core/tools/src/pipeline.ts, serviceAsk (~L431): an execution
 *     without an agent degrades to deny, and the ask goes to
 *     `ctx.get('approval').request({ agent, ... })`;
 *   packages/interaction/user-approval/src/index.ts, request (~L242): the
 *     ask/decide audit pair must sit inside an open turn, and the decision
 *     waterfall is dispatched in the requesting agent's scope.
 *
 * The proof registers an answerer on the user session agent's scope — the
 * same seam a UI answerer uses — and checks the whole path: the ask reaches
 * the user session's agent inside its open turn, the audit pair is durable on
 * that session's log, and the grant lets the tool run. It then repeats with a
 * rejecting answerer and with no answerer at all (fail closed).
 *
 * Run: pnpm proof:approval
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  spikeApprovalAsks,
  spikeToolRuns,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-4'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One approval answerer run, recorded for the assertions. */
const answererRuns: { agentId: string; toolName: string; outcome: string }[] = []

/** Register an answerer on one agent's scope, the way a UI answerer does. */
function answerOn(agent: Agent, outcome: 'allowed-once' | 'rejected'): () => void {
  return agent.ctx.on('approval/request', async (req) => {
    answererRuns.push({ agentId: req.agent.id, toolName: req.toolName, outcome })
    return outcome
  })
}

async function main(): Promise<void> {
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborOverlay, scriptedOverlay],
  })
  try {
    // ---- granted: the ask reaches the user session's agent, inside its turn.
    const grantedSession = brandString<SessionId>(`session-${randomUUID()}`)
    const granted = await createArborSession(ctx, grantedSession)
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'spike_ask', args: { action: 'guarded-action' } }] },
      { text: 'the guarded action ran' },
    ]
    const stopAnswerer = answerOn(granted, 'allowed-once')
    granted.followup(createUserMessage({ content: [{ type: 'text', text: 'run the guarded action' }], source: { kind: 'user' } }))
    await granted.whenIdle()
    stopAnswerer()

    check('approval ask produced', spikeApprovalAsks.length === 1,
      `asks: ${JSON.stringify(spikeApprovalAsks)}`)
    check('ask routed to the user session agent',
      answererRuns.length === 1 && answererRuns[0]?.agentId === granted.id
        && answererRuns[0]?.toolName === 'spike_ask',
      `answerer runs: ${JSON.stringify(answererRuns)}`)

    const grantedLog = logOf(granted)
    const asked = grantedLog.filter(entry => entry.type === 'approval/asked')
    const decided = grantedLog.filter(entry => entry.type === 'approval/decided')
    check('approval audit pair on the user session log', asked.length === 1 && decided.length === 1,
      `asked=${asked.length} decided=${decided.length}`)
    const turnEnclosed = turnEncloseCheck(grantedLog, asked[0]?.seq ?? -1, decided[0]?.seq ?? -1)
    check('audit pair inside the open turn', turnEnclosed,
      `asked at seq ${asked[0]?.seq}, decided at seq ${decided[0]?.seq}, turn/start..turn/end=${turnEnclosed}`)
    check('granted tool ran', spikeToolRuns.length === 1
      && JSON.stringify(spikeToolRuns[0]?.args).includes('guarded-action'),
      `tool runs: ${JSON.stringify(spikeToolRuns)}`)
    const grantedResults = grantedLog.filter(entry => entry.type === 'tool/result')
    check('granted result logged', grantedResults.length === 1,
      `tool/result events: ${grantedResults.length}`)
    const grantedAssistant = grantedLog.filter(entry => entry.type === 'assistant/message')
      .flatMap(entry => {
        const message = (entry.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
        return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
      })
    check('model saw the granted result', grantedAssistant.some(text => text.includes('the guarded action ran')),
      `assistant texts: ${JSON.stringify(grantedAssistant)}`)

    // ---- rejected: the tool does not run and the model sees the denial.
    const rejectedSession = brandString<SessionId>(`session-${randomUUID()}`)
    const rejected = await createArborSession(ctx, rejectedSession)
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'spike_ask', args: { action: 'blocked-action' } }] },
      { text: 'the guarded action was refused' },
    ]
    const stopRejecting = answerOn(rejected, 'rejected')
    rejected.followup(createUserMessage({ content: [{ type: 'text', text: 'run the guarded action again' }], source: { kind: 'user' } }))
    await rejected.whenIdle()
    stopRejecting()

    const rejectedLog = logOf(rejected)
    const rejectedDecided = rejectedLog.filter(entry => entry.type === 'approval/decided')
    check('rejected decision recorded', rejectedDecided.length === 1
      && (rejectedDecided[0]?.data as { outcome?: string }).outcome === 'rejected',
      `decided: ${JSON.stringify(rejectedDecided[0]?.data)}`)
    check('rejected tool did not run', spikeToolRuns.length === 1,
      `tool runs after rejection: ${spikeToolRuns.length}`)
    const rejectedResults = rejectedLog.filter(entry => entry.type === 'tool/result')
    const rejectedText = rejectedResults.flatMap(entry => {
      const message = (entry.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
      return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
    })
    check('model saw the rejection reason', rejectedText.some(text => text.includes('the user rejected tool "spike_ask"')),
      `tool result texts: ${JSON.stringify(rejectedText)}`)

    // ---- no answerer: the ask fails closed.
    const closedSession = brandString<SessionId>(`session-${randomUUID()}`)
    const closed = await createArborSession(ctx, closedSession)
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'spike_ask', args: { action: 'unanswered-action' } }] },
      { text: 'no approval channel was available' },
    ]
    closed.followup(createUserMessage({ content: [{ type: 'text', text: 'run the guarded action once more' }], source: { kind: 'user' } }))
    await closed.whenIdle()

    const closedLog = logOf(closed)
    const closedDecided = closedLog.filter(entry => entry.type === 'approval/decided')
    check('unanswered ask fails closed', closedDecided.length === 1
      && (closedDecided[0]?.data as { outcome?: string }).outcome === 'unavailable',
      `decided: ${JSON.stringify(closedDecided[0]?.data)}`)
    check('fail-closed tool did not run', spikeToolRuns.length === 1,
      `tool runs after fail-closed: ${spikeToolRuns.length}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Create one arbor session agent, like every other proof. */
async function createArborSession(ctx: Context, sessionId: SessionId): Promise<Agent> {
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd(), agentPreset: 'arbor' },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  return agent
}

/** One session's durable log, in order. */
function logOf(agent: Agent): { type: string; seq: number; data: unknown }[] {
  const log: { type: string; seq: number; data: unknown }[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) log.push({ type: event.type, seq, data: event.data })
  }
  return log
}

/** Whether one seq range sits between a turn/start and its turn/end. */
function turnEncloseCheck(
  log: { type: string; seq: number }[],
  from: number,
  to: number,
): boolean {
  const start = log.findLast(entry => entry.type === 'turn/start' && entry.seq < from)
  const end = log.find(entry => entry.type === 'turn/end' && entry.seq > to)
  return start !== undefined && end !== undefined && start.seq < from && to < end.seq
}

const uninstallFailLoud = installFailLoud(NAME)
try {
  await main()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  uninstallFailLoud()
}
console.log(failures.length === 0 ? 'PROOF 4 OK' : `PROOF 4 FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
