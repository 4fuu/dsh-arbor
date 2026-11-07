/**
 * Proof 9: a window ends and the session's next turn opens the window that
 * follows it, with the DSH session log staying correct throughout.
 *
 * B1 leaves the window lifetime to arbor's own defaults — the deployment sets
 * no idle period — so both endings a window can have are covered:
 *
 *  A. the model ends the window with a handoff: the host records the end and
 *     opens a continuation, which keeps the chain's watermarks and its
 *     predecessor's directory. The next turn drives that continuation rather
 *     than opening a second chain, and the log carries one system prompt for
 *     the whole session.
 *  B. the window goes quiet and arbor's idle policy ends it: the chain is
 *     finished, and the session's next turn opens a fresh window. The log
 *     still shows both turns, one system prompt, and no tool call left without
 *     a result — which is what a provider demands of a history.
 *
 * Part B boots with the idle period shortened to one second, so the proof does
 * not wait five minutes for the same policy the shipped settings leave at
 * arbor's 300 s default.
 *
 * Run: pnpm proof:lifetime
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  waitFor,
  windowOf,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-9'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const lifetimeOverlay = fileURLToPath(new URL('../patches/lifetime.patch.yml', import.meta.url))

/** The handoff the scripted model hands over when it ends the window. */
const HANDOFF = {
  topics: ['the pong task'],
  progress: ['the first answer was given'],
  pending: [],
  agreements: [],
}

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One session's durable log, in order. */
function logOf(agent: Agent): { type: string; data: unknown }[] {
  const log: { type: string; data: unknown }[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) log.push({ type: event.type, data: event.data })
  }
  return log
}

/** The assistant texts on one session's log. */
function assistantTexts(agent: Agent): string[] {
  return logOf(agent).filter(entry => entry.type === 'assistant/message').flatMap(entry => {
    const message = (entry.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
    return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
  })
}

/**
 * The tool calls the log's assistant messages ask for that no result answers.
 * A provider refuses a history with one of these, so this is the log's
 * provider-validity invariant.
 */
function danglingToolCalls(agent: Agent): readonly string[] {
  const asked = new Map<string, string>()
  const answered = new Set<string>()
  for (const entry of logOf(agent)) {
    if (entry.type === 'assistant/message') {
      const data = entry.data as { interrupted?: true; message?: { content?: readonly ContentBlock[] } }
      if (data.interrupted === true) continue
      for (const block of data.message?.content ?? []) {
        if (block.type === 'tool-call') asked.set(block.id, block.name)
      }
    }
    if (entry.type === 'tool/result') {
      const data = entry.data as { message?: { toolCallId?: string } }
      if (data.message?.toolCallId !== undefined) answered.add(data.message.toolCallId)
    }
  }
  return [...asked].filter(([callId]) => !answered.has(callId)).map(([, name]) => name)
}

/** One arbor session, created and driven for one turn. */
async function turn(
  ctx: Context,
  sessionId: SessionId,
  text: string,
): Promise<Agent> {
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd(), agentPreset: 'arbor' },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

/** The journal's window_start and window_end events for one session. */
async function windowEventsOf(ctx: Context, sessionId: SessionId): Promise<string[]> {
  const host = arborHostOf(ctx)
  const events: string[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await host.host.journal.list({ kinds: ['window_start', 'window_end'], limit: 200, offset })
    for (const event of page.items) {
      if (event.targets.includes(`dsh:session:${sessionId}`)) {
        events.push(`${event.window} ${event.kind} ${event.body ?? ''}`)
      }
    }
    if (page.items.length < 200) break
  }
  return events
}

async function partA(): Promise<void> {
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'end', args: { handoff: HANDOFF } }] },
      { text: 'handed the work over' },
    ]
    const agent = await turn(ctx, sessionId, 'end the window with a handoff')
    const first = windowOf(ctx, sessionId)!
    // The host settles the end and opens the continuation after the tool call
    // has answered, so the proof waits for the journal to say so — and waits for
    // the continuation itself, not merely for the end: the two are separate
    // commits, and the end lands a few milliseconds first.
    const afterFirst = await waitFor(async (): Promise<string[] | undefined> => {
      const events = await windowEventsOf(ctx, sessionId)
      return events.some(entry => entry.includes('window_end') && entry.includes('model_ended'))
        && events.some(entry => entry.includes('window_start') && entry.includes(`"continuation":"${first}"`))
        ? events
        : undefined
    }, 15_000)
    check('the first window ended when the model asked',
      afterFirst.some(entry => entry.startsWith(`${first} window_end`) && entry.includes('model_ended')),
      `journal: ${afterFirst.join(' | ')}`)
    check('the end carried a handoff', afterFirst.some(entry => entry.includes('"handoff":true')),
      `journal: ${afterFirst.join(' | ')}`)
    check('a continuation opened for the chain',
      afterFirst.some(entry => entry.includes('window_start') && entry.includes(`"continuation":"${first}"`)),
      `journal: ${afterFirst.join(' | ')}`)
    const continuation = (await host.windowFor(sessionId))!
    check('the continuation is the session window now', continuation !== first,
      `windows: ${first} then ${continuation}`)
    check('the continuation is live in the host',
      host.host.live().some(record => record.window === continuation),
      `live windows: ${host.host.live().map(record => record.window).join(', ')}`)
    check('the end call is mirrored on the session log',
      danglingToolCalls(agent).length === 0
      && logOf(agent).some(entry => entry.type === 'tool/call'
        && (entry.data as { name?: string }).name === 'end'),
      `log: ${logOf(agent).map(entry => entry.type).join(' ')}`)

    // The next turn drives the continuation rather than opening a second chain.
    scriptedLlm.responses = [{ text: 'the continuation answers' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const afterSecond = await windowEventsOf(ctx, sessionId)
    check('the next turn drove the continuation',
      afterSecond.filter(entry => entry.includes('window_start')).length === 2
      && await host.windowFor(sessionId) === continuation
      && windowOf(ctx, sessionId) === continuation,
      `journal: ${afterSecond.join(' | ')}`)
    check('the continuation answered', assistantTexts(agent).includes('the continuation answers'),
      `assistant texts: ${JSON.stringify(assistantTexts(agent))}`)
    const log = logOf(agent)
    check('both turns are on the log', log.filter(entry => entry.type === 'turn/start').length === 2,
      `turn/start events: ${log.filter(entry => entry.type === 'turn/start').length}`)
    check('the system prompt was admitted once', log.filter(entry => entry.type === 'system/message').length === 1,
      `system/message events: ${log.filter(entry => entry.type === 'system/message').length}`)
    check('no tool call is left without a result', danglingToolCalls(agent).length === 0,
      `dangling calls: ${JSON.stringify(danglingToolCalls(agent))}`)
    check('both turns closed cleanly', log.filter(entry => entry.type === 'turn/end').length === 2
      && (log.at(-1)?.data as { reason?: { kind?: string } }).reason?.kind === 'completed',
      `turn/end events: ${log.filter(entry => entry.type === 'turn/end').length}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function partB(): Promise<void> {
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, lifetimeOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    scriptedLlm.responses = [{ text: 'the first window answers' }]
    const agent = await turn(ctx, sessionId, 'say pong')
    const first = windowOf(ctx, sessionId)!
    check('the window opened for the first turn', first !== undefined, `window: ${first}`)

    // Arbor's idle policy ends the window one second after its run ended.
    const ended = await waitFor(async (): Promise<string[] | undefined> => {
      const events = await windowEventsOf(ctx, sessionId)
      return events.some(entry => entry.startsWith(`${first} window_end`) && entry.includes('idle_timeout'))
        ? events
        : undefined
    }, 15_000)
    check('the idle policy ended the window', ended.some(entry => entry.includes('idle_timeout')),
      `journal: ${ended.join(' | ')}`)
    check('the ended window is no longer live', host.host.live().every(record => record.window !== first),
      `live windows: ${host.host.live().map(record => record.window).join(', ')}`)

    // The next turn opens the window that follows it.
    scriptedLlm.responses = [{ text: 'the next window answers' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong again' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const second = windowOf(ctx, sessionId)!
    const events = await windowEventsOf(ctx, sessionId)
    check('the next turn opened a new window', second !== first
      && events.filter(entry => entry.includes('window_start')).length === 2,
      `journal: ${events.join(' | ')}`)
    check('the new window answered', assistantTexts(agent).includes('the next window answers'),
      `assistant texts: ${JSON.stringify(assistantTexts(agent))}`)
    const log = logOf(agent)
    check('both turns are on the log', log.filter(entry => entry.type === 'turn/start').length === 2,
      `turn/start events: ${log.filter(entry => entry.type === 'turn/start').length}`)
    check('the system prompt was admitted once', log.filter(entry => entry.type === 'system/message').length === 1,
      `system/message events: ${log.filter(entry => entry.type === 'system/message').length}`)
    check('no tool call is left without a result', danglingToolCalls(agent).length === 0,
      `dangling calls: ${JSON.stringify(danglingToolCalls(agent))}`)
    check('both turns closed cleanly', log.filter(entry => entry.type === 'turn/end').length === 2
      && log.every(entry => entry.type !== 'turn/end'
        || (entry.data as { reason?: { kind?: string } }).reason?.kind === 'completed'),
      `turn/end reasons: ${JSON.stringify(log.filter(entry => entry.type === 'turn/end')
        .map(entry => (entry.data as { reason?: { kind?: string } }).reason?.kind))}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

const uninstallFailLoud = installFailLoud(NAME)
try {
  await partA()
  await partB()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  uninstallFailLoud()
}
finishProof('PROOF 9', failures)
