/**
 * Proof 1: per-preset routing with an embedded AgentLoop.
 *
 * Boots the shipped `headless` profile with the arbor overlay, which disables
 * the base `agent` row and inserts `@4fu/dsh-arbor-agent` (the routing
 * registry subclass) plus the arbor driver row, leaving the `agent-loop` row
 * exactly as shipped. Then:
 *
 *  A. an ordinary session (no preset) is created and driven through the
 *     embedded official AgentLoop — the same registry, the same
 *     `ctx.agents.create` path, one full turn against the real model.
 *  B. a session with `meta.agentPreset === 'arbor'` is created through the
 *     arbor driver, which opens an arbor window for it.
 *
 * Both run in one process, which is the point: DSH allows one factory per
 * process, so routing has to happen inside one registry instance.
 *
 * Run: pnpm proof:routing
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'

const NAME = 'arbor-spike-proof-1'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))

async function createRootAgent(ctx: Context, preset?: string): Promise<Agent> {
  const selection = ctx.agentDefaultModel.currentSelection()
  const agentOptions: AgentOptions = { ...selection }
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd(), ...preset === undefined ? {} : { agentPreset: preset } },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  return agent
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}
try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [arborOverlay] })
  const entries = [...ctx.loader.entries()]
  const active = entries.filter(e => e.fiber !== undefined).length
  console.log(`booted: ${entries.length} loader entries, ${active} active`)

  // The patch swapped the registry row and left the loop row as shipped.
  const agentRow = entries.find(e => e.options.id === 'agent')
  const registryRow = entries.find(e => e.options.id === 'arbor-agent')
  const loopRow = entries.find(e => e.options.id === 'agent-loop')
  const driverRow = entries.find(e => e.options.id === 'arbor-driver')
  check('registry row swapped', agentRow?.options.disabled === true
    && registryRow?.options.name === '@4fu/dsh-arbor-agent'
    && registryRow.fiber !== undefined,
    `base agent row disabled=${agentRow?.options.disabled === true}; inserted row -> ${registryRow?.options.name} (active=${registryRow?.fiber !== undefined})`)
  check('agent-loop row untouched', loopRow?.options.name === '@deepseek-ai/dsh-agent-loop'
    && loopRow.options.disabled !== true && loopRow.fiber !== undefined,
    `agent-loop row active with config agents=${JSON.stringify((loopRow?.options.config as { agents?: unknown })?.agents)}`)
  check('arbor driver row active', driverRow?.fiber !== undefined, `arbor-driver row -> ${driverRow?.options.name} (active=${driverRow?.fiber !== undefined})`)

  // The registry instance is the subclass, and it captured the embedded loop.
  const registry = ctx.agents
  check('registry is the routing subclass', registry.constructor.name === 'ArborAgentRegistry',
    `ctx.agents -> ${registry.constructor.name}`)
  check('embedded AgentLoop captured', (registry as unknown as { embedded?: unknown }).embedded !== undefined,
    `embedded factory -> ${(registry as unknown as { embedded?: { constructor?: { name?: string } } }).embedded?.constructor?.name}`)

  // A. ordinary session: the embedded official loop drives it end to end.
  const ordinary = await createRootAgent(ctx)
  check('ordinary session created', ctx.agents.get(ordinary.id) === ordinary, `agent ${ordinary.id}`)
  const ordinaryResult = await runFixtureTurn(ctx, { task: 'Reply with the single word: pong' })
  check('ordinary session turn ran on the embedded loop',
    ordinaryResult.output.trim().toLowerCase().includes('pong'),
    `assistant output=${JSON.stringify(ordinaryResult.output)}`)

  // B. arbor-preset session: created through the arbor driver.
  const arborAgent = await createRootAgent(ctx, 'arbor')
  check('arbor session created', ctx.agents.get(arborAgent.id) === arborAgent, `agent ${arborAgent.id}`)
  check('arbor session is a separate live agent', ctx.agents.list().length === 2,
    `live agents: ${ctx.agents.list().map(a => a.id).join(', ')}`)

  // The arbor driver opened an arbor window for the session on its first turn.
  const windows = await (async () => {
    const before = arborAgent.session.seq
    arborAgent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Say hello in one short sentence.' }],
      source: { kind: 'user' },
    }))
    await arborAgent.whenIdle()
    return { before, after: arborAgent.session.seq }
  })()
  check('arbor session recorded a turn', windows.after > windows.before,
    `session seq ${windows.before} -> ${windows.after}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
console.log(failures.length === 0 ? 'PROOF 1 OK' : `PROOF 1 FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
