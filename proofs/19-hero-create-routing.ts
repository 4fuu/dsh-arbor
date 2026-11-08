/**
 * Proof 19: the hero path creates the session under the picked preset.
 *
 * Picking Arbor in the hero composer used to be committed on the blank session
 * the composer already belonged to, and the driver then had to swap the agent
 * under it — which DSH cannot do without leaving the hero's binding stale. The
 * fix is upstream of that: the surface that knows what the user clicked creates
 * a new session under the picked preset instead of committing on the blank, so
 * the session is *created* under the driver it will run. This proof checks the
 * host half of that path, along the exact calls the browser client makes:
 *
 *  A. `sessionController.create({ cwd, agentPreset: 'arbor' })` is the host half
 *     of the client's own `ISessions.create`
 *     (`@deepseek-ai/dsh-cordis-client-runner`, `lib/client.js`), which is the
 *     `session/create` remote verb. With no `sessionId` the controller mints:
 *     `createSession` → `createMinted(request.cwd,
 *     await this.composeAgent(request.agentPreset))`
 *     (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`), so the
 *     composition's preset lands in the session's creation `meta` — the one
 *     thing `ArborAgentRegistry.create` routes on. The session header carries
 *     it durably.
 *  B. the driver therefore routes at create: the session holds an arbor world,
 *     the journal names it, and its first turn reaches for arbor's tools and
 *     never for DSH's own project tool.
 *  C. no `agent-preset/selected` event is written on the way, because the pick
 *     never became a selection — it was the session's composition from birth.
 *  D. no agent is resumed for that session, which is the observable a re-route
 *     would leave: `rerouteToArbor`/`rerouteToEmbedded` both end one agent and
 *     open the session again through `agents.resume`. The driver's fallback for
 *     the paths that never reach the hero seat stays covered by proof 15.
 *  E. the other direction is the same shape: a session created under
 *     `standard` runs the embedded loop and holds no arbor world.
 *
 * Run: pnpm proof:hero-create-routing
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'
import {
  arborHostOf,
  finishProof,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-19'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
// The roster a deployment with a preset picker has, so the composition the hero
// path names resolves — exactly what the shipped profile's presets/ layer does.
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))
// The web profile, because the path under test is the browser client's: the
// `sessionController` row that serves `session/create` is part of the web-app
// bundle, and the call below is its host half.
const PORT = 3087
const webOverlay = fileURLToPath(new URL('../patches/hero-path.patch.yml', import.meta.url))

/** The preset whose sessions run arbor, and the one every other session runs. */
const ARBOR = 'arbor'
const STANDARD = 'standard'

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** The host half of the client's `ISessions.create`, which the hero path calls. */
interface SessionController {
  create(request: {
    cwd?: string
    agentPreset?: string
    sessionId?: string
  }): Promise<{ sessionId: SessionId; agentPreset?: string }>
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

/** Every event type one session's log carries, in order. */
function eventTypesOf(agent: Agent): string[] {
  const types: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) types.push(event.type)
  }
  return types
}

/** Every journal event kind the process recorded. */
async function journalKinds(): Promise<string[]> {
  const host = arborHostOf(ctx!)
  const page = await host.host.journal.list({ limit: 500 })
  return page.items.map(item => item.kind)
}

/** The journal rows that name one session. */
async function journalTargets(sessionId: SessionId): Promise<number> {
  const host = arborHostOf(ctx!)
  const page = await host.host.journal.list({ limit: 500 })
  return page.items.filter(item => item.targets.includes(`dsh:session:${sessionId}`)).length
}

try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'web',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay, webOverlay],
    prepare: (root) => {
      root.provide('webStartup', { openBrowser: false, host: '127.0.0.1', port: PORT, trustedHosts: ['127.0.0.1'] })
    },
  })
  const host = arborHostOf(ctx)
  const shared = host.sharedFolder
  const driver = ctx.get('arborDriver') as {
    sessionArbor(id: SessionId): unknown
    systemPromptOf(id: SessionId): string | undefined
  }
  const controller = ctx.get('sessionController') as unknown as SessionController
  check('the session controller is mounted', controller !== undefined,
    `ctx.sessionController -> ${controller === undefined ? 'absent' : 'present'}`)

  // The registry the routing reads, and the agent factory's own entry points,
  // so a re-route is visible as an extra create or resume for one session id.
  const agents = ctx.agents as unknown as {
    create(options: unknown): Promise<unknown>
    resume(options: unknown): Promise<unknown>
    get(id: SessionId): Agent | undefined
  }
  const calls: { kind: string; sessionId?: string; agentPreset?: string }[] = []
  const originalCreate = agents.create.bind(agents)
  const originalResume = agents.resume.bind(agents)
  agents.create = async (options: unknown): Promise<unknown> => {
    const request = options as { sessionId?: SessionId; meta?: { agentPreset?: string } }
    calls.push({ kind: 'create', sessionId: request.sessionId, agentPreset: request.meta?.agentPreset })
    return originalCreate(options)
  }
  agents.resume = async (options: unknown): Promise<unknown> => {
    const request = options as { resumeSessionId?: SessionId }
    calls.push({ kind: 'resume', sessionId: request.resumeSessionId })
    return originalResume(options)
  }

  // ---- A. the hero path's create, with the pick in it.
  const created = await controller.create({ cwd: shared, agentPreset: ARBOR })
  check('the controller mints a session for a create with no sessionId',
    typeof created.sessionId === 'string' && created.sessionId.startsWith('session-'),
    `created ${created.sessionId}`)
  check("the create answers with the preset it ran", created.agentPreset === ARBOR,
    `create -> ${String(created.agentPreset)}`)
  const agent = agents.get(created.sessionId)
  check('the session header carries the picked preset durably',
    agent !== undefined && agent.session.header.agentPreset === ARBOR,
    `header agentPreset = ${String(agent?.session.header.agentPreset)}`)
  check('the create composed the session under the picked preset',
    calls.filter(call => call.kind === 'create' && call.sessionId === created.sessionId).length === 1
      && calls.some(call => call.kind === 'create' && call.sessionId === created.sessionId
        && call.agentPreset === ARBOR),
    `agents.create for it: ${JSON.stringify(calls.filter(call => call.sessionId === created.sessionId))}`)

  // ---- B. it is routed at create, so its first turn runs arbor.
  check('the session holds an arbor world without any re-route',
    driver.sessionArbor(created.sessionId) !== undefined,
    `sessionArbor -> ${driver.sessionArbor(created.sessionId) === undefined ? 'absent' : 'present'}`)
  scriptedLlm.responses = [{ toolCalls: [{ name: 'read', args: { path: 'README.md' } }] }, { text: 'listed' }]
  agent!.followup(createUserMessage({ content: [{ type: 'text', text: 'list the files' }], source: { kind: 'user' } }))
  await agent!.whenIdle()
  const calls19 = toolCallsOf(agent!)
  check('the created session reaches for arbor tools',
    calls19.includes('read'),
    `tool calls: ${calls19.join(', ') || '(none)'}`)
  check("the created session never reaches for DSH's own project tool",
    !calls19.includes('working_directory'),
    `tool calls: ${calls19.join(', ') || '(none)'}`)
  check('the journal records an arbor window for it',
    (await journalKinds()).includes('window_start'),
    `journal kinds: ${[...new Set(await journalKinds())].join(', ')}`)
  // A window is opened by the session's first send, so the attribution the host
  // records for it exists only after that turn.
  check('the journal attributes the window to the session',
    (await journalTargets(created.sessionId)) > 0,
    `journal rows naming it: ${await journalTargets(created.sessionId)}`)

  // ---- C. the pick was never a selection.
  const types = eventTypesOf(agent!)
  check('the session log records no preset selection',
    !types.includes('agent-preset/selected'),
    `log events: ${[...new Set(types)].join(', ')}`)

  // ---- D. nothing was resumed for it, which is what a re-route would leave.
  const resumed = calls.filter(call => call.kind === 'resume' && call.sessionId === created.sessionId)
  check('the driver re-routed nothing on the hero path',
    resumed.length === 0 && driver.sessionArbor(created.sessionId) !== undefined,
    `agents.resume for it: ${resumed.length}`)

  // ---- E. the other direction is the same shape, and ordinary is unchanged.
  const standard = await controller.create({ cwd: shared, agentPreset: STANDARD })
  const standardAgent = agents.get(standard.sessionId)
  check('a session created under standard runs the embedded loop',
    standardAgent !== undefined
      && standardAgent.session.header.agentPreset === STANDARD
      && driver.sessionArbor(standard.sessionId) === undefined,
    `header agentPreset = ${String(standardAgent?.session.header.agentPreset)}; `
      + `arbor world: ${driver.sessionArbor(standard.sessionId) === undefined ? 'absent' : 'present'}`)
  const standardTypes = eventTypesOf(standardAgent!)
  check('the standard session records no selection either',
    !standardTypes.includes('agent-preset/selected'),
    `log events: ${[...new Set(standardTypes)].join(', ')}`)

  // A create that names no preset is DSH's own path, not the hero's: the
  // controller resolves the deployment default and records it, exactly as it
  // does for any surface that creates a session without a pick.
  const plain = await controller.create({ cwd: shared })
  const plainAgent = agents.get(plain.sessionId)
  check('a create with no preset runs the resolved default, not arbor',
    plainAgent !== undefined
      && plainAgent.session.header.agentPreset === STANDARD
      && driver.sessionArbor(plain.sessionId) === undefined,
    `header agentPreset = ${String(plainAgent?.session.header.agentPreset)}; `
      + `arbor world: ${driver.sessionArbor(plain.sessionId) === undefined ? 'absent' : 'present'}`)

  agents.create = originalCreate
  agents.resume = originalResume
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstallFailLoud()
  finishProof('hero-create-routing', failures)
}
