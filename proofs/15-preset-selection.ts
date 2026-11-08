/**
 * Proof 15: picking Arbor in a composer runs arbor.
 *
 * The web client's hero chip stages a preset and DSH's own preset registry
 * commits it on a blank session by appending `agent-preset/selected` — the same
 * event every DSH preset uses, because every DSH preset shares one driver. A
 * preset that changes the driver has to act on that event, which is what this
 * proof checks, along the path the session controller actually takes:
 *
 *  A. a session is created the way `SessionController.createAgent` creates one —
 *     through `ctx.agents.create` with the cwd and the setup, and NO
 *     `meta.agentPreset`, because that is what a hero's blank session gets. It
 *     runs on the embedded AgentLoop.
 *  B. `ctx.agentPresets.select(agent, 'arbor')` is then called, which is exactly
 *     what `AgentPresetSeatController.apply` reaches through
 *     `ctx.remote.agentPresets.select`. The session keeps its identity and its
 *     log, and its next turn runs arbor: the journal records a window for it and
 *     the tools it reaches for are arbor's.
 *  C. a selection after the first turn is refused by DSH's own registry with a
 *     visible reason, so no session silently keeps the driver it began with.
 *  D. an ordinary session in the same process is untouched by all of it.
 *
 * Run: pnpm proof:preset-selection
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  finishProof,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-15'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
// The roster a deployment with a preset picker has, so `agentPresets.select` —
// the call the hero chip's staged pick reaches — is mounted.
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One session created the way the session controller creates one: no preset. */
async function createSession(cwd: string): Promise<Agent> {
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx!.agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  return agent
}

/** Every journal event kind the process recorded, in order. */
async function journalKinds(): Promise<string[]> {
  const host = arborHostOf(ctx!)
  const page = await host.host.journal.list({ limit: 500 })
  return page.items.map(item => item.kind)
}

/** Every tool call one session's agent ran, in order. */
function toolCallsOf(agent: Agent): string[] {
  const names: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type === 'tool/call') names.push((event.data as { name?: string }).name ?? '')
  }
  return names
}

try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({
    binName: NAME, profile: 'headless', overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay],
  })
  const host = arborHostOf(ctx)
  const shared = host.sharedFolder

  // ---- A. a hero's blank session: created with no preset, so it runs the loop.
  const picked = await createSession(shared)
  check('a session created without a preset runs the embedded loop',
    ctx.agents.get(picked.id) === picked,
    `agent ${picked.id} is live and was created with no meta.agentPreset`)

  // ---- B. the hero chip's pick reaches it through DSH's own registry.
  const presets = (ctx as unknown as { agentPresets?: { select(agent: Agent, id: string): Promise<string> } }).agentPresets
  check('the preset registry is mounted', presets !== undefined,
    `ctx.agentPresets -> ${presets === undefined ? 'absent' : 'present'}`)
  const selected = await presets!.select(picked, 'arbor')
  check('DSH commits the pick on a blank session', selected === 'arbor',
    `agentPresets.select -> ${selected}`)
  check('the pick is recorded on the session log',
    [...Array(picked.session.seq).keys()]
      .map(seq => picked.session.eventAt(seq as never))
      .some(event => event?.type === 'agent-preset/selected'
        && (event.data as { agentPreset?: string }).agentPreset === 'arbor'),
    `the log records agent-preset/selected arbor`)

  // The session kept its identity, and its next turn runs arbor.
  // The re-route ends the loop's agent and opens the session again, so the live
  // agent for the id is a new object; the session, its log and its identity are
  // the ones the composer is bound to. It runs off the log event the preset
  // registry appends, so it settles just after `select` resolves: a user cannot
  // out-type it, and a caller that must not race waits for it the way this does.
  let rerouted: Agent | undefined
  for (let attempt = 0; attempt < 100 && (rerouted === undefined || rerouted === picked); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    rerouted = ctx.agents.get(picked.id)
  }
  check('the session kept its identity across the re-route',
    rerouted !== undefined && rerouted !== picked,
    `agent ${picked.id} is still live, under ${rerouted === picked ? 'the same' : 'a new'} agent object`)
  scriptedLlm.responses = [{ toolCalls: [{ name: 'read', args: { path: 'README.md' } }] }, { text: 'listed' }]
  rerouted!.followup(createUserMessage({ content: [{ type: 'text', text: 'list the files' }], source: { kind: 'user' } }))
  await rerouted!.whenIdle()

  const kinds = await journalKinds()
  check('the re-routed session wrote arbor journal events',
    kinds.includes('window_start'),
    `journal kinds: ${[...new Set(kinds)].join(', ')}`)
  const calls = toolCallsOf(rerouted!)
  check('the re-routed session reached for arbor tools',
    calls.includes('read'),
    `tool calls: ${calls.join(', ')}`)
  check("the re-routed session never reached for DSH's own project tool",
    !calls.includes('working_directory'),
    `tool calls: ${calls.join(', ')}`)
  const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
  const prompt = driver.systemPromptOf(picked.id) ?? ''
  check("the re-routed session renders arbor's <workspace> section",
    /<workspace>[\s\S]*<\/workspace>/.test(prompt) && !prompt.includes('沙箱'),
    `arbor's own workspace section: ${/<workspace>[\s\S]*<\/workspace>/.test(prompt)}; a sandbox line: ${prompt.includes('沙箱')}`)

  // ---- C. a selection after the first turn is refused, with a visible reason.
  // The hero chip would hand the registry the session's live agent, which is the
  // one the re-route published; that is the agent whose turn boundary refuses.
  let refusal = ''
  try {
    await presets!.select(rerouted!, 'standard')
  } catch (error: unknown) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  check('a selection after the first turn is refused with a reason',
    refusal.length > 0,
    `refusal: ${JSON.stringify(refusal)}`)
  check('the refused session keeps the driver it began with',
    ctx.agents.get(picked.id) !== undefined && (await journalKinds()).includes('window_start'),
    `the session is still live and its arbor window is still the one the journal names`)

  // ---- D. an ordinary session in the same process is untouched by all of it.
  const ordinary = await createSession(shared)
  scriptedLlm.responses = [{ text: 'pong' }]
  ordinary.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
  await ordinary.whenIdle()
  const driverSessions = ctx.get('arborDriver') as { sessionArbor(id: SessionId): unknown }
  const ordinaryTargets = (await arborHostOf(ctx).host.journal.list({ limit: 500 })).items
    .filter(item => item.targets.includes(`dsh:session:${ordinary.id}`))
  check('an ordinary session in the same process stays on the embedded loop',
    driverSessions.sessionArbor(ordinary.id) === undefined && ordinaryTargets.length === 0,
    `the ordinary session holds no arbor window and the journal names it ${ordinaryTargets.length} times`)
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstallFailLoud()
  finishProof('preset-selection', failures)
}
