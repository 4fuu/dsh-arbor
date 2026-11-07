/**
 * Proof 10: a persisted arbor session resumes after DSH restarts.
 *
 * B0 threw a descriptive error here. B1 loads the session the way the official
 * loop loads it, replays onto its log what the arbor journal recorded and the
 * log lost, and binds the session to the window the host continued at boot —
 * so the next turn drives that window instead of opening a second chain.
 *
 * Three sections:
 *
 *  1. The relay's own logic, on synthetic input: the calls the journal
 *     recorded, the log's own view of them, and what has to be replayed. This
 *     is where the ordering, the answered and the started cases are pinned.
 *  2. A clean restart: a turn, the process disposed, a second boot on the same
 *     DSH home, and the session resumed for another turn.
 *  3. An interrupted restart: the session's log is left with a crash tail — an
 *     assistant message asking for a tool call the log never recorded, while
 *     the journal holds the call — and the resume has to leave the log whole:
 *     the replayed `tool/call` plus DSH's own interrupted closers, and no tool
 *     call left without a result.
 *
 * Run: pnpm proof:resume
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { interruptedTurnClosers, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  MemoryJournal,
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  windowOf,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'
import { relayToolCalls, windowToolCalls } from '../packages/arbor-driver/src/relay.ts'

const NAME = 'arbor-spike-proof-10'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
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

/** The assistant texts on one session's log. */
function assistantTexts(agent: Agent): string[] {
  return logOf(agent).filter(entry => entry.type === 'assistant/message').flatMap(entry => {
    const message = (entry.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
    return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
  })
}

/** The tool calls the log asks for that no result answers. */
function danglingToolCalls(agent: Agent): readonly string[] {
  const asked = new Map<string, string>()
  const answered = new Set<string>()
  for (const entry of logOf(agent)) {
    if (entry.type === 'assistant/message') {
      const data = entry.data as { interrupted?: true; message?: { content?: readonly { type: string; id?: string; name?: string }[] } }
      if (data.interrupted === true) continue
      for (const block of data.message?.content ?? []) {
        if (block.type === 'tool-call') asked.set(block.id as string, block.name as string)
      }
    }
    if (entry.type === 'tool/result') {
      const data = entry.data as { message?: { toolCallId?: string } }
      if (data.message?.toolCallId !== undefined) answered.add(data.message.toolCallId)
    }
  }
  return [...asked].filter(([callId]) => !answered.has(callId)).map(([, name]) => name)
}

/** One synthetic assistant message asking for one tool call. */
function assistantAsking(
  turn: number,
  step: number,
  callId: string,
  name: string,
  args: string,
  interrupted?: true,
): Extract<SessionEvent, { type: 'assistant/message' }> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(0),
    time: 1,
    data: {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: args }],
        source: { provider: SCRIPTED_SELECTION.provider, model: SCRIPTED_SELECTION.model },
      }),
      stream: [],
      ...interrupted === undefined ? {} : { interrupted },
    },
    surfaceOp: 'append',
  }
}

/** One synthetic `tool/call` event. */
function callLogged(
  seq: number,
  turn: number,
  step: number,
  callId: string,
  name: string,
  args: string,
): Extract<SessionEvent, { type: 'tool/call' }> {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: 1,
    data: { turn, step, callId: ToolCallId(callId), name, arguments: args },
  }
}

/** One synthetic `tool/result` event. */
function resultLogged(
  seq: number,
  turn: number,
  step: number,
  callId: string,
  text: string,
): Extract<SessionEvent, { type: 'tool/result' }> {
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 1,
    data: {
      turn,
      step,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text }],
        isError: false,
      }),
    },
    surfaceOp: 'append',
  }
}

/** One arbor-preset session agent. */
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

/** Drive one turn and wait for it. */
async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

// ---- 1. the relay's own logic --------------------------------------------

async function relayUnit(): Promise<void> {
  const journal = new MemoryJournal()
  const window = 'c7' as const
  await journal.append({ kind: 'window_start', window, body: '{}', targets: ['dsh:session:s1'] })
  await journal.append({
    kind: 'tool_call',
    window,
    body: 'spike_echo {"text":"first"}',
    targets: [],
  })
  const second = await journal.append({
    kind: 'tool_call',
    window,
    body: 'spike_echo {"text":"second"}',
    targets: [],
  })
  await journal.append({
    kind: 'tool_call',
    window,
    body: 'spike_echo {"text":"third"}',
    targets: [],
  })
  await journal.append({ kind: 'tool_result', window, body: 'echo: first', targets: [], refs: ['r1' as never] })

  const calls = await windowToolCalls(journal, [window])
  check('the journal read gives the window calls in order',
    calls.length === 3 && calls.map(call => call.args).join(' ') === '{"text":"first"} {"text":"second"} {"text":"third"}',
    `calls: ${JSON.stringify(calls)}`)
  check('the answered call is the one the result names',
    calls[0]?.settled === true && calls[1]?.settled === false && calls[2]?.settled === false,
    `settled: ${calls.map(call => call.settled).join(', ')}`)

  // The log: the first call ran and was answered, the second was recorded as
  // started, and the third was never recorded. The interrupted attempt's block
  // is not part of the order arbor's calls follow.
  const log: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
    assistantAsking(1, 1, 'call-1', 'spike_echo', '{"text":"first"}'),
    callLogged(3, 1, 1, 'call-1', 'spike_echo', '{"text":"first"}'),
    resultLogged(4, 1, 1, 'call-1', 'echo: first'),
    assistantAsking(1, 2, 'call-2', 'spike_echo', '{"text":"second"}'),
    callLogged(6, 1, 2, 'call-2', 'spike_echo', '{"text":"second"}'),
    assistantAsking(1, 3, 'call-3', 'spike_echo', '{"text":"third"}'),
    assistantAsking(1, 4, 'call-interrupted', 'spike_echo', '{"text":"interrupted"}', true),
  ]

  const replayed = relayToolCalls(log, calls)
  check('only the call the log lost is replayed',
    replayed.length === 1
    && replayed[0]?.data.callId === ToolCallId('call-3')
    && replayed[0]?.data.name === 'spike_echo'
    && replayed[0]?.data.turn === 1 && replayed[0]?.data.step === 3,
    `replayed: ${JSON.stringify(replayed.map(event => event.data))}`)
  check('the replayed call continues the log sequence',
    replayed[0]?.seq === (log.at(-1)?.seq ?? 0) + 1,
    `seq: ${replayed[0]?.seq} after ${log.at(-1)?.seq}`)

  // DSH's own repair then closes the tail: the replayed call is a started one,
  // so its result says the outcome is unknown rather than not started.
  const closers = interruptedTurnClosers([...log, ...replayed])
  const results = closers.filter(event => event.type === 'tool/result')
  const codes = results.map(event => event.type === 'tool/result'
    ? `${event.data.message.toolCallId}:${event.data.error?.code ?? 'none'}`
    : event.type)
  check('the repair closes every unanswered call of the open turn',
    codes.join(' ') === 'call-2:TOOL_OUTCOME_UNKNOWN call-3:TOOL_OUTCOME_UNKNOWN call-interrupted:TOOL_NOT_STARTED',
    `results: ${JSON.stringify(codes)}`)
  check('the repair closes the open step and turn',
    closers.some(event => event.type === 'step/end')
    && closers.some(event => event.type === 'turn/end'),
    `closers: ${closers.map(event => event.type).join(' ')}`)

  // A call whose name or arguments do not line up stops the replay rather than
  // guessing which call it was.
  const mismatched = relayToolCalls(log, [calls[0]!, { name: 'other_tool', args: '{}', settled: false }])
  check('a mismatch stops the replay', mismatched.length === 0, `replayed: ${JSON.stringify(mismatched)}`)
}

// ---- 2. a clean restart ---------------------------------------------------

async function cleanRestart(): Promise<void> {
  scriptedLlm.responses = [
    { toolCalls: [{ name: 'spike_echo', args: { text: 'before the restart' } }] },
    { text: 'answered before the restart' },
  ]
  const home = await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  let ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  let agent: Agent
  try {
    agent = await createArborSession(ctx, sessionId)
    await turn(agent, 'echo once')
    const firstWindow = await arborHostOf(ctx).windowFor(sessionId)
    check('the first process opened a window', firstWindow !== undefined, `window: ${firstWindow}`)
  } finally {
    await ctx.fiber.dispose()
  }

  // The second process: the host starts, continues the window the journal says
  // was running, and the session resumes onto it.
  scriptedLlm.responses = [{ text: 'answered after the restart' }]
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const continued = await host.windowFor(sessionId)
    check('the restart continued the session window', continued !== undefined,
      `the host continued: ${continued ?? 'nothing'}`)
    const { agent: resumed } = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    check('the resumed session is an arbor session', resumed.session.header.agentPreset === 'arbor',
      `header agentPreset=${resumed.session.header.agentPreset ?? 'none'}`)
    check('the resumed session is bound to the continued window',
      continued !== undefined && await host.windowFor(sessionId) === continued,
      `window: ${continued}`)
    check('the log survived the restart whole',
      danglingToolCalls(resumed).length === 0
      && logOf(resumed).filter(entry => entry.type === 'turn/end').length === 1,
      `log: ${logOf(resumed).map(entry => entry.type).join(' ')}`)
    check('the system prompt was not admitted twice',
      logOf(resumed).filter(entry => entry.type === 'system/message').length === 1,
      `system/message events: ${logOf(resumed).filter(entry => entry.type === 'system/message').length}`)

    await turn(resumed, 'echo again')
    check('the resumed session answered', assistantTexts(resumed).includes('answered after the restart'),
      `assistant texts: ${JSON.stringify(assistantTexts(resumed))}`)
    check('the resumed turn continued the session turn numbering',
      logOf(resumed).filter(entry => entry.type === 'turn/start').length === 2
      && (logOf(resumed).at(-1)?.data as { turn?: number }).turn === 2,
      `turns: ${JSON.stringify(logOf(resumed).filter(entry => entry.type === 'turn/start')
        .map(entry => (entry.data as { turn?: number }).turn))}`)
    const chain = await host.windowChainOf(sessionId)
    check('the session kept one window chain across the restart', chain.length === 2,
      `the session window chain: ${chain.join(' -> ')}`)
    check('the resumed turn drove the continued window',
      windowOf(ctx, sessionId) === continued,
      `the driver's window: ${windowOf(ctx, sessionId) ?? 'none'}; the host continued: ${continued}`)
    const headers = logOf(resumed).filter(entry => entry.type === 'request/header')
    check('the resumed request header says resume',
      headers.some(entry => (entry.data as { reason?: string }).reason === 'resume'),
      `request/header reasons: ${JSON.stringify(headers.map(entry => (entry.data as { reason?: string }).reason))}`)
    check('no tool call is left without a result after the restart', danglingToolCalls(resumed).length === 0,
      `dangling calls: ${JSON.stringify(danglingToolCalls(resumed))}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

// ---- 3. an interrupted restart -------------------------------------------

async function interruptedRestart(): Promise<void> {
  scriptedLlm.responses = [
    { toolCalls: [{ name: 'spike_echo', args: { text: 'the answered call' } }] },
    { text: 'answered before the crash' },
  ]
  const home = await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  let ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const agent = await createArborSession(ctx, sessionId)
    await turn(agent, 'echo once')
    const host = arborHostOf(ctx)
    const window = (await host.windowFor(sessionId))!

    // A crash tail: the turn was open, the model had asked for one more call,
    // the journal recorded it, and the session log never did. The journal is
    // the deployment's own record, so the call is written there the way the
    // driver writes every call it runs.
    const turnNumber = logOf(agent).filter(entry => entry.type === 'turn/start').length + 1
    const step = 1
    agent.session.append('turn/start', { turn: turnNumber })
    agent.session.append('step/start', { turn: turnNumber, step })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'echo the crashed call' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn: turnNumber,
      step,
      message: createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('crashed-call'),
          name: 'spike_echo',
          arguments: '{"text":"the crashed call"}',
        }],
        source: { provider: SCRIPTED_SELECTION.provider, model: SCRIPTED_SELECTION.model },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    await host.host.journal.append({
      kind: 'tool_call',
      window,
      body: 'spike_echo {"text":"the crashed call"}',
      targets: [],
    })
    check('the crash tail is open and unanswered before the restart',
      danglingToolCalls(agent).includes('spike_echo')
      && !logOf(agent).some(entry => entry.type === 'turn/end'
        && (entry.data as { turn?: number }).turn === turnNumber),
      `log tail: ${logOf(agent).slice(-5).map(entry => entry.type).join(' ')}`)
  } finally {
    await ctx.fiber.dispose()
  }

  scriptedLlm.responses = [{ text: 'answered after the crash' }]
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const { agent: resumed } = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    const log = logOf(resumed)
    check('the resume did not throw', resumed.session.id === sessionId, `session: ${resumed.session.id}`)
    check('the replayed call is on the log',
      log.some(entry => entry.type === 'tool/call'
        && (entry.data as { callId?: string }).callId === 'crashed-call'),
      `tool/call events: ${JSON.stringify(log.filter(entry => entry.type === 'tool/call')
        .map(entry => (entry.data as { callId?: string }).callId))}`)
    check('no tool call is left without a result',
      danglingToolCalls(resumed).length === 0,
      `dangling calls: ${JSON.stringify(danglingToolCalls(resumed))}`)
    const crashedResults = log.filter(entry => entry.type === 'tool/result'
      && (entry.data as { message?: { toolCallId?: string } }).message?.toolCallId === 'crashed-call')
    check('the replayed call is closed as outcome-unknown',
      crashedResults.length === 1
      && (crashedResults[0]?.data as { error?: { code?: string } }).error?.code === 'TOOL_OUTCOME_UNKNOWN',
      `the crashed call's result: ${JSON.stringify(crashedResults.map(entry => entry.data))}`)
    check('the interrupted turn is closed',
      log.filter(entry => entry.type === 'turn/end').length === 2
      && log.some(entry => entry.type === 'turn/end'
        && (entry.data as { reason?: { kind?: string } }).reason?.kind === 'interrupted'),
      `turn/end reasons: ${JSON.stringify(log.filter(entry => entry.type === 'turn/end')
        .map(entry => (entry.data as { reason?: { kind?: string } }).reason?.kind))}`)

    await turn(resumed, 'echo after the crash')
    check('the session answered after the crash', assistantTexts(resumed).includes('answered after the crash'),
      `assistant texts: ${JSON.stringify(assistantTexts(resumed))}`)
    check('the log is still whole', danglingToolCalls(resumed).length === 0,
      `dangling calls: ${JSON.stringify(danglingToolCalls(resumed))}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

const uninstallFailLoud = installFailLoud(NAME)
try {
  await relayUnit()
  await cleanRestart()
  await interruptedRestart()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  uninstallFailLoud()
}
finishProof('PROOF 10', failures)
