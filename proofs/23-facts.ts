/**
 * Proof 23: the facts the arbor panels read are arbor's own, and they move.
 *
 * One arbor session is driven through a turn, ended with a handoff, continued,
 * and changed underneath: the facts service is asked for its snapshot at each
 * point and the answers are checked against arbor's own reads — the journal's
 * window chain, the board, the workspace, the note store, `/env`, the schedule
 * list and the settings. The same session is then watched through
 * `ctx.arborFacts.open`, which is the function the web route uses, and the
 * frames must carry both a rebuild and a live `text_delta` from
 * `Arbor.stream(window, …)`.
 *
 * Run: pnpm proof:facts
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
import type { Handoff } from '@4fu/arbor-interfaces'
import { sessionTarget } from '@4fu/dsh-arbor-host'
import type { ArborFactsFrame } from '@4fu/dsh-arbor-facts'
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

const NAME = 'arbor-spike-proof-23'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const dshEnvOverlay = fileURLToPath(new URL('../patches/dsh-env.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** The handoff an end carries, with one ref. */
function handoffOf(ref: string): Handoff {
  return {
    topics: ['proof 23'],
    progress: ['the facts are read from arbor'],
    pending: ['nothing'],
    agreements: [],
    refs: [ref as never],
  }
}

async function main(): Promise<void> {
  useDshFixtures()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await tempDir('arbor-facts-')
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const ctx: Context = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, dshEnvOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const factsOf = ctx.arborFacts
    const selection: AgentOptions = { ...SCRIPTED_SELECTION }
    scriptedLlm.responses = [{ text: 'first answer' }]
    const created = await ctx.agents.create({
      sessionId,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: selection,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    const agent = created.agent

    // ---- before the first turn: no window, but the host's own facts are there.
    const empty = await factsOf.factsFor(sessionId)
    check('the session is arbor', empty.preset === 'arbor', `preset=${empty.preset}`)
    check('an untouched session has no window', empty.windows.length === 0, `windows=${empty.windows.length}`)
    check('the workspace is arbor\'s own', empty.workspace.shared !== '' && empty.workspace.backend !== undefined,
      `backend=${empty.workspace.backend} shared=${empty.workspace.shared}`)
    check('the settings are arbor\'s deployment settings', empty.settings.source === 'deployment' && (empty.settings.identity ?? '') !== '',
      `source=${empty.settings.source}`)
    check('the environment is arbor\'s own', empty.env.items.some(item => item.builtin === true),
      `kinds=${JSON.stringify(empty.env.items.map(item => item.kind))}`)
    check('the active note set is read', Array.isArray(empty.notes.items), `epoch=${empty.notes.epoch}`)

    // ---- watch the session, the way the web route does.
    const frames: ArborFactsFrame[] = []
    const stop = await factsOf.open(sessionId, frame => { frames.push(frame) })
    const initial = frames.at(0)
    check('the watcher gets the facts first', initial?.type === 'facts', `first=${initial?.type ?? 'none'}`)

    // ---- one turn: the live window streams a delta, and the facts rebuild.
    let release: () => void = () => {}
    scriptedLlm.gate = new Promise<void>((resolve) => { release = resolve })
    scriptedLlm.responses = [{ text: 'the streamed answer' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say something' }], source: { kind: 'user' } }))
    const windowRef = await waitFor(() => host.windowFor(sessionId))
    release()
    scriptedLlm.gate = undefined
    await agent.whenIdle()
    const afterTurn = await factsOf.factsFor(sessionId)
    check('the turn opened one window', afterTurn.windows.length === 1, `windows=${afterTurn.windows.map(w => `${w.ref}:${w.state}`).join(',')}`)
    const firstWindow = afterTurn.windows[0]
    check('the live window is the host\'s live one', firstWindow?.live === true && firstWindow.ref === windowRef,
      `fact=${firstWindow?.ref}:${firstWindow?.state} host=${windowRef}`)
    check('the board line names what the window is doing', afterTurn.board.length === 1 && afterTurn.board[0]?.window === windowRef,
      `board=${JSON.stringify(afterTurn.board.map(line => line.window))}`)
    check('the chain has no continuation yet', firstWindow?.continuedBy === undefined && firstWindow?.continuationOf === undefined,
      `continuedBy=${firstWindow?.continuedBy ?? 'none'}`)
    const streamed = frames.filter(frame => frame.type === 'stream' && frame.window === windowRef)
    check('the live window\'s stream reaches the watcher', streamed.length > 0 && streamed.every(frame => frame.type === 'stream'),
      `frames=${streamed.length}`)
    const text = frames.flatMap(frame => frame.type === 'stream' && frame.event.kind === 'text_delta' ? [frame.event.delta] : []).join('')
    check('the stream carries the model\'s text', text.includes('the streamed answer'), `text=${JSON.stringify(text)}`)
    const rebuilt = frames.filter(frame => frame.type === 'facts').length
    check('the facts are rebuilt as the turn goes', rebuilt >= 2, `facts frames=${rebuilt}`)

    // ---- end the window with a handoff: the continuation is the chain's next act.
    scriptedLlm.responses = [{ text: 'continued' }]
    const liveBefore = host.host.live()[0]
    await liveBefore?.session?.end(handoffOf('n001'), 'model_ended')
    let chain: readonly string[] = []
    const deadline = Date.now() + 10_000
    while (chain.length < 2) {
      chain = await host.windowChainOf(sessionId)
      if (chain.length >= 2) break
      if (Date.now() > deadline) throw new Error('waitFor: the continuation never opened')
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const continued = chain.at(-1) as string
    while (!host.host.live().some(record => record.window === continued)) {
      if (Date.now() > deadline) throw new Error('waitFor: the continuation never became live')
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const afterEnd = await factsOf.factsFor(sessionId)
    const endedWindow = afterEnd.windows.find(window => window.ref === windowRef)
    const nextWindow = afterEnd.windows.find(window => window.ref === continued)
    check('the ended window records its reason', endedWindow?.endReason === 'model_ended',
      `reason=${endedWindow?.endReason ?? 'none'}`)
    check('the ended window records the handoff', endedWindow?.handoff?.present === true && (endedWindow.handoff.refs.length ?? 0) > 0,
      `handoff=${JSON.stringify(endedWindow?.handoff)}`)
    check('the chain links the continuation', endedWindow?.continuedBy === continued && nextWindow?.continuationOf === windowRef,
      `continuedBy=${endedWindow?.continuedBy} continuationOf=${nextWindow?.continuationOf}`)
    check('the continuation is live', nextWindow?.live === true, `state=${nextWindow?.state ?? 'missing'}`)
    check('the board now shows the continuation', afterEnd.board.some(line => line.window === continued),
      `board=${JSON.stringify(afterEnd.board.map(line => line.window))}`)

    // ---- the note store, the schedule list and search are arbor's own.
    const note = await host.notes.write({
      title: 'proof 23 note',
      summary: 'a note the facts panel can name',
      body: 'proof-23-distinctive-body',
    })
    const scheduled = await host.host.schedule({
      name: 'proof 23 schedule',
      firstAt: Date.now() + 3_600_000,
      targets: [sessionTarget(sessionId)],
      task: {
        reason: 'proof 23',
        targets: [sessionTarget(sessionId)],
        time: Date.now(),
        content: [],
      },
    })
    const afterWrites = await factsOf.factsFor(sessionId)
    // A new note does not enter the active set until arbor builds the next
    // epoch (its own 10-minute floor), so the panel's active set is the frozen
    // one and the note is reachable through arbor's search, which is the pair
    // the panel shows.
    check('the active set is the epoch\'s frozen set', Array.isArray(afterWrites.notes.items) && afterWrites.notes.epoch >= 1,
      `epoch=${afterWrites.notes.epoch} active=${JSON.stringify(afterWrites.notes.items.map(item => item.ref))}`)
    check('the schedule is listed and marked for this session',
      afterWrites.schedules.some(item => item.ref === scheduled && item.mine),
      `schedules=${JSON.stringify(afterWrites.schedules.map(item => `${item.ref}:${item.mine}`))}`)
    const found = await factsOf.search('proof-23-distinctive-body')
    check('search reads arbor\'s journal and notes', found.total > 0 && found.notes.some(hit => hit.ref === note.ref),
      `total=${found.total} notes=${JSON.stringify(found.notes.map(hit => hit.ref))}`)

    // ---- releasing the watcher stops the live subscription, not the facts.
    stop()
    const final = await factsOf.factsFor(sessionId)
    check('the facts outlive the watcher', final.windows.length >= 2, `windows=${final.windows.length}`)
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
finishProof('PROOF 23', failures)
