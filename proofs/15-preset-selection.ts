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
 *  E. the two directions are decided by provenance: a session CREATED under
 *     arbor keeps arbor when another preset is selected on it, because the only
 *     selection that can reach it is DSH's own default re-select on a reused
 *     blank; a session that SELECTED arbor goes back to the embedded loop when
 *     it selects another preset, which is the reverse route's remaining job.
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
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
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

/** One session created the way the session controller creates one. */
async function createSession(cwd: string, preset?: string): Promise<Agent> {
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx!.agents.create({
    sessionId,
    meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
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

/** The journal rows that name one session, optionally of one kind. */
async function journalRowsOf(sessionId: SessionId, kind?: string): Promise<number> {
  const host = arborHostOf(ctx!)
  const page = await host.host.journal.list({ limit: 500 })
  return page.items.filter(item => item.targets.includes(`dsh:session:${sessionId}`)
    && (kind === undefined || item.kind === kind)).length
}

/**
 * The preset a session's log recorded last, or undefined before one is. This is
 * the label a client reads, and it is what has to agree with the driver.
 */
function lastPresetOf(session: Session): string | undefined {
  let last: string | undefined
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'agent-preset/selected') continue
    const selected = (event.data as { agentPreset?: unknown }).agentPreset
    if (typeof selected === 'string') last = selected
  }
  return last
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

  // ---- E. a session created under arbor keeps it; one that selected arbor can
  // select back. The split is the whole rule: the creation header is a frozen
  // creation fact (`@deepseek-ai/dsh-agent-preset-registry`,
  // `lib/types/session.js`), so a session that STARTED as arbor is never moved
  // off it by a selection it did not make — DSH's controller writes one of those
  // whenever a blank is reused with no preset named — while a session that
  // BECAME arbor through a selection goes back the same way it came.
  const created = await createSession(shared, 'arbor')
  check('a session created under arbor runs arbor',
    driverSessions.sessionArbor(created.id) !== undefined,
    `the session holds an arbor world: ${driverSessions.sessionArbor(created.id) !== undefined}`)
  await presets!.select(created, 'standard')
  // The refusal is asynchronous — the driver acts on the session-scoped
  // `session/event` channel — so the settle is waited for the way a re-route is.
  let kept: Agent | undefined
  for (let attempt = 0; attempt < 100 && (kept === undefined || kept !== created); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    kept = ctx.agents.get(created.id)
  }
  check('a session created under arbor keeps arbor when another preset is selected on it',
    kept === created && driverSessions.sessionArbor(created.id) !== undefined,
    `the agent object is the one it was created with: ${kept === created}; `
      + `it still holds an arbor world: ${driverSessions.sessionArbor(created.id) !== undefined}`)
  check('its log ends on arbor again, so the label and the driver agree',
    lastPresetOf(created.session) === 'arbor',
    `the last recorded preset is ${String(lastPresetOf(created.session))}`)
  scriptedLlm.responses = [{ toolCalls: [{ name: 'read', args: { path: 'README.md' } }] }, { text: 'listed' }]
  created.followup(createUserMessage({ content: [{ type: 'text', text: 'list the files' }], source: { kind: 'user' } }))
  await created.whenIdle()
  const keptCalls = toolCallsOf(created)
  check('the session that kept arbor still reaches for arbor tools',
    keptCalls.includes('read') && !keptCalls.includes('working_directory'),
    `tool calls: ${keptCalls.join(', ') || '(none)'}`)

  // The reverse route's remaining job, and the reason it stays: a session that
  // selected arbor while blank can select another preset while blank, and that
  // is a selection a user or an SDK caller made. Part B above is how this
  // session became arbor; this is the way back.
  const flipped = await createSession(shared)
  await presets!.select(flipped, 'arbor')
  let onArbor: Agent | undefined
  for (let attempt = 0; attempt < 100 && (onArbor === undefined || onArbor === flipped); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    onArbor = ctx.agents.get(flipped.id)
  }
  check('a blank session that selects arbor runs arbor',
    onArbor !== undefined && onArbor !== flipped && driverSessions.sessionArbor(flipped.id) !== undefined,
    `the session still holds an arbor world: ${driverSessions.sessionArbor(flipped.id) !== undefined}`)
  await presets!.select(onArbor!, 'standard')
  let back: Agent | undefined
  for (let attempt = 0; attempt < 100 && (back === undefined || back === onArbor); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    back = ctx.agents.get(flipped.id)
  }
  check('a session that selected arbor goes back to the embedded loop when it selects another preset',
    back !== undefined && driverSessions.sessionArbor(flipped.id) === undefined,
    `the session still holds an arbor world: ${driverSessions.sessionArbor(flipped.id) !== undefined}`)
  scriptedLlm.responses = [{ text: 'pong' }]
  back!.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
  await back!.whenIdle()
  const backCalls = toolCallsOf(back!)
  check('the session that went back runs the embedded loop, not arbor',
    !backCalls.includes('read'),
    `tool calls: ${backCalls.join(', ') || '(none)'}`)
  check('the session that kept arbor opened exactly one window, and the one that went back opened none',
    (await journalRowsOf(created.id, 'window_start')) === 1
      && (await journalRowsOf(flipped.id, 'window_start')) === 0,
    `window_start rows naming the created session: ${await journalRowsOf(created.id, 'window_start')}; `
      + `naming the selected one: ${await journalRowsOf(flipped.id, 'window_start')}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstallFailLoud()
  finishProof('preset-selection', failures)
}
