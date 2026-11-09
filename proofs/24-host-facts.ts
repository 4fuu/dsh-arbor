/**
 * Proof 24: the whole-host facts are the labeled sessions' own arbor state.
 *
 * One arbor session is driven through a live turn while the page's host stream
 * is open, and a second, ordinary DSH session is driven beside it. The host
 * view must name only the arbor session, must carry DSH's session title and
 * the window the label opened, must push a rebuild and a live delta, and must
 * leave the ordinary session out. The chain is then read through the same
 * `sessionId` label the driver attached, with no window-start map of the
 * browser's own.
 *
 * Run: pnpm proof:host-facts
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-24'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  useDshFixtures()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await mkdtemp(join(tmpdir(), 'arbor-host-facts-'))
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
