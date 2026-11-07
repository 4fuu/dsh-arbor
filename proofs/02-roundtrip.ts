/**
 * Proof 2: a user message in a DSH session reaches an arbor window and the
 * window's answer comes back as an assistant message, with streaming.
 *
 * Run with the scripted model (deterministic, no network): the script is one
 * tool call followed by one text answer, so the proof covers the whole loop —
 * message in, window opened, tool call executed through arbor's tool path
 * into `ctx.tools.execute`, answer streamed back.
 *
 * Assertions:
 *  - the user message text is in the DSH session log as `user/message`;
 *  - the arbor window saw the task (its journal holds the window_start with
 *    the session's target);
 *  - the tool call ran inside DSH (the test tool's execute was invoked, and
 *    the durable `tool/call` + `tool/result` pair is on the user session's
 *    log, logged at the live turn/step);
 *  - the answer came back as one `assistant/message` with the scripted text;
 *  - streaming: `agent/assistant-stream` frames arrive in order
 *    start -> chunk -> end(committed), and the arbor window's own event bus
 *    carries the text deltas and the tool call/result;
 *  - the turn closes cleanly (turn/end with reason completed).
 *
 * Run: pnpm proof:roundtrip            (scripted model, deterministic)
 *      ARBOR_PROOF_LIVE=1 pnpm proof:roundtrip   (real DeepSeek model)
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  spikeToolRuns,
  waitFor,
  windowOf,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-2'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

/**
 * ARBOR_PROOF_LIVE=1 runs the same roundtrip against the real DeepSeek model
 * instead of the scripted one (the scripted tool call is replaced by a plain
 * text answer, because the real model is not scripted).
 */
const live = process.env['ARBOR_PROOF_LIVE'] === '1'

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  scriptedLlm.responses = [
    { toolCalls: [{ name: 'spike_echo', args: { text: 'ping from the window' } }] },
    { text: 'pong from the arbor window' },
  ]
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: live ? [arborPatch, arborOverlay] : [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const agentOptions: AgentOptions = live
      ? { ...ctx.agentDefaultModel.currentSelection() }
      : { ...SCRIPTED_SELECTION }
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })

    // Observe the window's own event stream beside the host's watch loop. The
    // scripted model is held at its gate until the window has opened and the
    // observer is attached, so no event of the turn is missed.
    const windowEvents: string[] = []
    let releaseGate!: () => void
    scriptedLlm.gate = new Promise<void>(resolve => { releaseGate = resolve })

    // Observe the DSH assistant stream frames.
    const frames: string[] = []
    const stopFrames = ctx.on('agent/assistant-stream', ({ frame }) => {
      frames.push(frame.type === 'end' ? `end:${frame.outcome.kind}` : frame.type)
    })

    const task = live
      ? 'Reply with exactly: pong from the arbor window'
      : 'Say pong, and call spike_echo once.'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    const window = await waitFor(() => windowOf(ctx, sessionId))
    const events = arborHostOf(ctx).backend.events(window)
    void (async () => {
      try {
        for await (const event of events) windowEvents.push(event.kind)
      } catch {
        // The bus closes with the window; observers stop here.
      }
    })()
    releaseGate()
    await agent.whenIdle()
    scriptedLlm.gate = undefined
    stopFrames()

    // Read the durable session log.
    const log: { type: string; data: unknown }[] = []
    for (let seq = 0; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(seq as never)
      if (event !== undefined) log.push({ type: event.type, data: event.data })
    }
    const types = log.map(entry => entry.type)
    console.log(`session log: ${types.join(' ')}`)

    const messageTexts = (type: string): string[] => log
      .filter(entry => entry.type === type)
      .flatMap(entry => {
        const message = (entry.data as { message?: { content?: readonly ContentBlock[] } }).message
        return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text)
      })
    const userText = log.filter(entry => entry.type === 'user/message')
      .flatMap(entry => {
        const message = entry.data as { content?: readonly ContentBlock[] }
        return (message.content ?? []).filter(block => block.type === 'text').map(block => block.text)
      })
    check('user message reached the session log', userText.includes(task), `user texts: ${JSON.stringify(userText)}`)

    const assistantText = messageTexts('assistant/message')
    check('assistant message came back', live
      ? assistantText.some(text => text.toLowerCase().includes('pong'))
      : assistantText.includes('pong from the arbor window'),
      `assistant texts: ${JSON.stringify(assistantText)}`)

    const toolCalls = log.filter(entry => entry.type === 'tool/call')
    const toolResults = log.filter(entry => entry.type === 'tool/result')
    if (!live) {
      check('tool call logged on the user session', toolCalls.length === 1
        && (toolCalls[0]?.data as { name?: string }).name === 'spike_echo',
        `tool/call events: ${toolCalls.length}`)
      check('tool executed inside DSH', spikeToolRuns.length === 1
        && JSON.stringify(spikeToolRuns[0]?.args).includes('ping from the window'),
        `tool runs: ${JSON.stringify(spikeToolRuns)}`)
    }
    const resultText = messageTexts('tool/result')
    if (!live) {
      check('tool result logged with the echoed text', resultText.some(text => text.includes('ping from the window')),
        `tool result texts: ${JSON.stringify(resultText)}`)
    }

    check('stream frames in order', frames.length >= 3 && frames[0] === 'start'
      && frames[frames.length - 1]?.startsWith('end:committed') && frames.includes('chunk'),
      `frames: ${frames.join(' ')}`)

    check('window streamed the answer and the tool work', live
      ? windowEvents.includes('text_delta') && windowEvents.includes('run_ended')
      : windowEvents.includes('text_delta') && windowEvents.includes('tool_call')
        && windowEvents.includes('tool_result') && windowEvents.includes('run_ended'),
      `window events: ${windowEvents.join(' ')}`)

    const turnEnd = log.filter(entry => entry.type === 'turn/end')
    check('turn closed cleanly', turnEnd.length === 1
      && (turnEnd[0]?.data as { reason?: { kind?: string } }).reason?.kind === 'completed',
      `turn/end: ${JSON.stringify(turnEnd[0]?.data)}`)

    // The arbor window itself recorded the session's task.
    const journalTypes = await (async () => {
      const page = await arborHostOf(ctx).host.journal.list({ limit: 50 })
      return (page?.items ?? []).map(item => `${item.kind}:[${item.targets.join(',')}]`)
    })()
    check('arbor window recorded the session task',
      journalTypes.some(kind => kind.startsWith('window_start') && kind.includes(`dsh:session:${sessionId}`)),
      `journal: ${journalTypes.join(' ')}`)

    // The model saw the DSH session log as its messages, and the tools.
    if (!live) {
      check('model request carried the session messages',
        scriptedLlm.seen.length >= 2 && scriptedLlm.seen[0] !== undefined
        && JSON.stringify(scriptedLlm.seen[0].messages).includes(task),
        `requests: ${scriptedLlm.seen.length}`)
      const declaredTools = (scriptedLlm.seen[0]?.tools ?? []).map(tool => tool.name)
      check('model saw the DSH tool declared', declaredTools.includes('spike_echo'),
        `declared tools: ${declaredTools.join(', ')}`)
    } else {
      const header = log.filter(entry => entry.type === 'request/header')
      check('live model request logged', header.length >= 1,
        `request/header events: ${header.length}`)
    }
  } finally {
    await ctx.fiber.dispose()
  }
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
console.log(failures.length === 0 ? 'PROOF 2 OK' : `PROOF 2 FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
