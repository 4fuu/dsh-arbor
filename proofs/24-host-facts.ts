/**
 * Proof 24: the whole-host facts are the labeled sessions' own arbor state.
 *
 * One arbor session is driven through a live turn while the page's host stream
 * is open, and a second, ordinary DSH session is driven beside it. A related
 * input delivered while the first window is idle must start its next DSH turn.
 * The host view must name only the arbor session, must carry DSH's session
 * title and the window the label opened, must push a rebuild and a live delta,
 * and must leave the ordinary session out. The chain is then read through the
 * same `sessionId` label the driver attached, with no window-start map of the
 * browser's own.
 *
 * Run: pnpm proof:host-facts
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import type { ArborHostFrame } from '@4fu/dsh-arbor-facts'
import { sessionTarget } from '@4fu/dsh-arbor-host'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  finishProof,
  freshDshHome,
  scriptedLlm,
  useDshFixtures,
  waitFor,
  tempDir,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-24'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** The assistant texts on one session's log. */
function assistantTexts(agent: any): string[] {
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } })
      .message?.content ?? []
    for (const block of content) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
    }
  }
  return texts
}

async function main(): Promise<void> {
  useDshFixtures()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await tempDir('arbor-host-facts-')
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const ordinaryId = brandString<SessionId>(`session-${randomUUID()}`)
  const ctx: Context = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const selection: AgentOptions = { ...SCRIPTED_SELECTION }
    const frames: ArborHostFrame[] = []
    const stop = await ctx.arborFacts.openHost(frame => { frames.push(frame) })
    check('the host stream opens with the facts', frames.at(0)?.type === 'facts', `first=${frames.at(0)?.type ?? 'none'}`)

    scriptedLlm.responses = [{ text: 'host-facts answer' }]
    const created = await ctx.agents.create({
      sessionId,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: selection,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    const agent: any = created.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say the host facts answer' }], source: { kind: 'user' } }))
    const windowRef = await waitFor(() => host.windowFor(sessionId))
    await agent.whenIdle();
    // The run's end is a journal append (`run_ended`), so the open host stream
    // hears it without anyone calling `hostFactsFor()` and without watching a
    // backend bus.
    const idle = await waitFor(() => frames
      .filter(frame => frame.type === 'facts')
      .map(frame => frame.facts)
      .find(facts => facts.sessions.some(session => session.sessionId === sessionId
        && session.windows.some(window => window.ref === windowRef && window.state === 'idle'))), 10_000)
      .catch(() => undefined)
    check('the host stream hears the run end without a manual rebuild', idle !== undefined,
      `states=${JSON.stringify(frames.filter(frame => frame.type === 'facts').flatMap(frame => frame.facts.sessions.flatMap(session => session.windows.filter(window => window.ref === windowRef).map(window => `${window.ref}:${window.state}`))))}`)
    const journalKinds = (await host.journal.list({ window: windowRef as never, limit: 200 })).items.map(event => event.kind)
    check('the journal records the run end and its usage', journalKinds.includes('run_ended') && journalKinds.includes('usage'),
      `kinds=${JSON.stringify([...new Set(journalKinds)])}`)

    // A related input delivered while the window is idle is not dropped: the
    // host sends it through `followUp`, and this backend must start the next
    // DSH turn for it. A session state copied from the host's idle would drop
    // it here.
    scriptedLlm.responses = [{ text: 'the idle window answered' }]
    await host.host.deliver(windowRef, {
      kind: 'inserted_task',
      role: 'input',
      refs: [],
      time: Date.now(),
      content: [{ kind: 'data', fields: { content: 'continue from the idle window' } }],
    }, { targets: [sessionTarget(sessionId)] })
    // `waitFor` settles on anything but `undefined`, so a boolean predicate has
    // to answer `true` or `undefined`: returning bare `false` would end the wait
    // before the delivered turn has run.
    const delivered = await waitFor(() => assistantTexts(agent).includes('the idle window answered') || undefined, 10_000)
      .catch(() => undefined)
    check('an input delivered to an idle window starts its next turn', delivered === true,
      `assistant texts: ${JSON.stringify(assistantTexts(agent))}`)

    // An `end` arbor refuses keeps the window alive: the facts carry the rule
    // and the window's real state, never an ended one.
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'end', args: { handoff: { topic: 'CI' } } }] },
      { text: 'the window is still open' },
    ]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'end with a malformed handoff' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // The host settles `run_ended` on its own watch loop, one turn after the
    // DSH agent reports the turn done. Wait for the second run's journal row as
    // well as the idle state: the record is idle before that turn's first event
    // too, so idle alone does not mean the refusal's run has settled.
    await waitFor(async () => {
      const runs = (await host.journal.list({ window: windowRef as never, kinds: ['run_ended'], limit: 50 })).total
      const idle = host.host.live().every(record => record.window !== windowRef || record.state === 'idle')
      return runs >= 2 && idle ? true : undefined
    }, 10_000)
    const afterRefusal = await ctx.arborFacts.hostFactsFor()
    const refused = afterRefusal.windows.find(window => window.ref === windowRef)
    const runEnds = (await host.journal.list({ window: windowRef as never, kinds: ['run_ended'], limit: 50 })).total
    check('a refused end leaves the window live and idle',
      refused?.live === true && refused.state === 'idle',
      `state=${refused?.state ?? 'missing'} live=${String(refused?.live)} facts=${JSON.stringify(afterRefusal.windows.map(window => `${window.ref}:${window.state}`))} host=${JSON.stringify(host.host.live().map(record => `${record.window}:${record.state}`))} run_ended=${runEnds}`)
    check('the facts carry the refused rule and arbor\'s wording',
      refused?.endRefused?.rule === 'end.handoff.invalid'
      && refused.endRefused.message.includes('topics')
      && refused.endRefused.message.includes('progress'),
      `refusal=${JSON.stringify(refused?.endRefused)}`)
    const ends = await host.journal.list({ window: windowRef as never, kinds: ['window_end'], limit: 10 })
    check('the refused end recorded no window_end', ends.total === 0, `window_end rows: ${ends.total}`)

    const titleSession = agent.session as unknown as { append(type: string, data: unknown): unknown };
    titleSession.append('session/title', { title: 'Proof 24 arbor session' })

    // The ordinary session runs a real turn too, and must not appear.
    const ordinary = await ctx.agents.create({
      sessionId: ordinaryId,
      meta: { cwd: project, agentPreset: 'standard' },
      agentOptions: selection,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    const plain: any = ordinary.agent
    plain.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary turn' }], source: { kind: 'user' } }))
    await plain.whenIdle

    const facts = await ctx.arborFacts.hostFactsFor()
    const arborRow = facts.sessions.find(session => session.sessionId === sessionId)
    check('the labeled arbor session is named', arborRow !== undefined, `sessions=${JSON.stringify(facts.sessions.map(row => row.sessionId))}`)
    check('the ordinary session is absent', !facts.sessions.some(session => session.sessionId === ordinaryId), `ordinary=${ordinaryId}`)
    check("the row leads with DSH's session title", arborRow?.title === 'Proof 24 arbor session', `title=${arborRow?.title ?? 'none'}`)
    check('the row carries the window the label opened', arborRow?.windows.some(window => window.ref === windowRef) === true,
      `windows=${JSON.stringify(arborRow?.windows.map(window => window.ref))}`)
    check('the board line is the user\'s request, not the driver placeholder',
      facts.board.find(line => line.window === windowRef)?.doing === 'say the host facts answer',
      `doing=${JSON.stringify(facts.board.find(line => line.window === windowRef)?.doing)}`)
    check('the host view has one live window', facts.windows.some(window => window.ref === windowRef && window.live),
      `windows=${JSON.stringify(facts.windows.map(window => `${window.ref}:${window.state}`))}`)
    check('the ordinary session added no host window', facts.windows.every(window => window.ref !== undefined && arborRow?.windows.some(one => one.ref === window.ref)),
      `windows=${facts.windows.length}`)
    const start = await host.journal.list({ window: windowRef as never, kinds: ['window_start'], limit: 10 })
    const label = start.items.map(event => {
      try { return (JSON.parse(event.body ?? '{}') as { label?: string }).label } catch { return undefined }
    }).find(value => value !== undefined)
    check('the journal carries the DSH session id as the label', label === sessionId, `label=${label ?? 'none'}`)
    const rebuilt = frames.filter(frame => frame.type === 'facts').length
    check('the host stream rebuilds as the turn goes', rebuilt >= 2, `facts frames=${rebuilt}`)
    const streamed = frames.filter(frame => frame.type === 'stream' && frame.window === windowRef)
    check('the host stream carries a live delta', streamed.length > 0, `stream frames=${streamed.length}`)
    stop()
    const afterStop = await ctx.arborFacts.hostFactsFor()
    check('the facts outlive the stream', afterStop.sessions.some(session => session.sessionId === sessionId),
      `sessions=${afterStop.sessions.length}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

const uninstall = installFailLoud(NAME)
try {
  await main()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  uninstall()
}
finishProof('PROOF 24', failures)
