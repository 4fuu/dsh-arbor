/**
 * Proof 0: the boot harness itself. Boots the shipped `headless` profile with
 * the control overlay (no arbor code), creates one ordinary agent through
 * `ctx.agents.create`, and drives one turn with the real DeepSeek model
 * through `runFixtureTurn` (the same driver DSH's own loader-smoke tests use).
 *
 * This proves the npm-installed DSH tree, the profile composition, and the
 * turn machinery all work before any arbor code is involved.
 *
 * Run: pnpm proof:boot
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'

const NAME = 'arbor-spike-proof-0'
const controlOverlay = fileURLToPath(new URL('../patches/control.patch.yml', import.meta.url))

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
try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [controlOverlay] })
  const entries = [...ctx.loader.entries()]
  console.log(`booted: ${entries.length} loader entries, ${entries.filter(e => e.fiber !== undefined).length} active`)
  const agentRow = entries.find(e => e.options.id === 'agent')
  console.log(`agent row: name=${agentRow?.options.name} disabled=${agentRow?.options.disabled === true}`)

  const agent = await createRootAgent(ctx)
  console.log(`created agent ${agent.id}, status=${agent.status}`)
  const result = await runFixtureTurn(ctx, {
    task: 'Reply with the single word: pong',
    onEvent: (_sessionId, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'assistant/message') {
        console.log(`event: ${event.type}`)
      }
    },
  })
  console.log(`RESULT output=${JSON.stringify(result.output)} usage=${JSON.stringify(result.usage)}`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
