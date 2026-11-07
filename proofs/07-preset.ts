/**
 * Proof 7: a user picks the arbor preset and the session runs on arbor.
 *
 * This is the user-visible path B1 delivers: the bundle patch puts `arbor` in
 * the deployment's preset roster through `@4fu/dsh-arbor-preset`, a session
 * created for that preset records it on its header and its log, and the
 * routing registry sends it to the arbor driver. An ordinary session created
 * in the same process, for the other preset the roster offers, keeps running
 * on the embedded official AgentLoop.
 *
 * The overlay mounts the preset registry a deployment with a picker has, plus
 * one ordinary declaration beside arbor's, the way a shipped profile's
 * presets/ layer does. The arbor declaration itself comes from the bundle
 * patch — what a user picks is what the bundle declares.
 *
 * Assertions:
 *  - the roster lists arbor, usable, beside the ordinary preset;
 *  - a session created for the arbor preset carries `agentPreset: 'arbor'` on
 *    its header, has joined the arbor composition, and records the selection
 *    on its log as `agent-preset/selected`;
 *  - that session's turn runs on arbor: an assistant message comes back and
 *    the journal holds a window_start carrying the session's target;
 *  - an ordinary session in the same process runs its turn on the embedded
 *    loop and gets no arbor window.
 *
 * Run: pnpm proof:preset
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  agentPresetsOf,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-7'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))

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

async function main(): Promise<void> {
  scriptedLlm.responses = [{ text: 'pong from the arbor preset' }]
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay],
  })
  try {
    // ---- the roster the bundle declares into.
    const presets = agentPresetsOf(ctx)
    const roster = await presets.list()
    const arbor = roster.find(row => row.id === 'arbor')
    check('arbor is in the preset roster', arbor !== undefined && arbor.broken === undefined,
      `roster: ${roster.map(row => `${row.id}${row.broken === undefined ? '' : ` (${row.broken})`}`).join(', ')}`)
    check('the ordinary preset is there too', roster.some(row => row.id === 'standard'),
      `roster: ${roster.map(row => row.id).join(', ')}`)

    // ---- a session created for the arbor preset. The header carries the
    // preset, which is what routes it; the picker's own call then records the
    // choice durably and mounts the composition, the way a session created
    // blank and picked in the UI does.
    const arborSession = brandString<SessionId>(`session-${randomUUID()}`)
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const { agent } = await ctx.agents.create({
      sessionId: arborSession,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    check('the session header records the arbor preset', agent.session.header.agentPreset === 'arbor',
      `header agentPreset=${agent.session.header.agentPreset ?? 'none'}`)

    // The picker's own call, before the session has started: it records the
    // choice durably on the log and mounts the composition.
    await presets.select(agent, 'arbor')
    check('the agent joined the arbor composition', presets.composedPreset(agent.ctx) === 'arbor',
      `composed preset=${presets.composedPreset(agent.ctx) ?? 'none'}`)
    const selected = logOf(agent).filter(entry => entry.type === 'agent-preset/selected')
    check('the log records the preset selection', selected.length === 1
      && (selected[0]?.data as { agentPreset?: string }).agentPreset === 'arbor',
      `agent-preset/selected events: ${JSON.stringify(selected.map(entry => entry.data))}`)

    // ---- that session's turn runs on arbor.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    check('the arbor-preset session answered', assistantTexts(agent).includes('pong from the arbor preset'),
      `assistant texts: ${JSON.stringify(assistantTexts(agent))}`)
    const journalTypes = await (async () => {
      const page = await arborHostOf(ctx).host.journal.list({ limit: 50 })
      return (page?.items ?? []).map(item => `${item.kind}:[${item.targets.join(',')}]`)
    })()
    check('an arbor window opened for the arbor-preset session',
      journalTypes.some(kind => kind.startsWith('window_start') && kind.includes(`dsh:session:${arborSession}`)),
      `journal: ${journalTypes.join(' ')}`)

    // ---- an ordinary session in the same process keeps running on the loop.
    const ordinarySession = brandString<SessionId>(`session-${randomUUID()}`)
    const ordinaryOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const { agent: ordinary } = await ctx.agents.create({
      sessionId: ordinarySession,
      meta: { cwd: process.cwd(), agentPreset: 'standard' },
      agentOptions: ordinaryOptions,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx)
        await presets.mount(agentCtx, 'standard')
      },
    })
    ordinary.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
    await ordinary.whenIdle()
    check('the ordinary-preset session answered on the embedded loop',
      assistantTexts(ordinary).includes('pong from the arbor preset'),
      `assistant texts: ${JSON.stringify(assistantTexts(ordinary))}`)
    const ordinaryWindows = journalTypes.filter(kind => kind.includes(`dsh:session:${ordinarySession}`))
    check('the ordinary session got no arbor window', ordinaryWindows.length === 0,
      `journal entries for the ordinary session: ${ordinaryWindows.length}`)
    // The window agent the arbor session registers is a subagent-origin child,
    // not a root, so the two user sessions are the two roots of one process.
    check('both sessions ran in one process',
      ctx.agents.roots().map(root => root.id).sort().join(',') === [arborSession, ordinarySession].sort().join(','),
      `roots: ${ctx.agents.roots().map(root => root.id).join(', ')}`)
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
finishProof('PROOF 7', failures)
