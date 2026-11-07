/**
 * Proof 3: window agents stay out of the session list.
 *
 * When the arbor driver opens a window for a session it registers the window
 * as a DSH agent with `meta.origin: 'subagent'` — the convention
 * `packages/subagent/subagent/src/child-agent.ts` uses for delegated children
 * — owned by the user session's agent, so it is not a registry root. The
 * shipped sidebar rule then leaves it out:
 *
 *   packages/client/ui-workspace/src/client/tree.ts, sessionVisible (~L229):
 *     if (session.origin === 'subagent') return false
 *
 * (the published client bundle carries the same rule:
 * `@deepseek-ai/dsh-client-ui-workspace` lib/client.js, sessionVisible).
 *
 * This proof asserts the durable facts that rule reads — the window session's
 * header `origin` and `parentSession`, and the user session's absence of an
 * origin — and then runs the rule itself over both sessions.
 *
 * Run: pnpm proof:hidden
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
import {
  SCRIPTED_SELECTION,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-3'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/**
 * The shipped sidebar rule, transcribed from
 * packages/client/ui-workspace/src/client/tree.ts (sessionVisible, ~L229):
 * a subagent-origin session is never visible; a blank session is visible only
 * while it is the current one; archived sessions follow the filter.
 */
function sessionVisible(
  session: { origin?: string; blank?: boolean; id: string },
  current: string | undefined,
  archived: ReadonlySet<string>,
  archivedFilter: 'default' | 'show' | 'only',
): boolean {
  if (session.origin === 'subagent') return false
  if (session.blank === true && session.id !== current) return false
  switch (archivedFilter) {
    case 'default':
      return !archived.has(session.id)
    case 'show':
      return true
    case 'only':
      return archived.has(session.id)
    default:
      return false
  }
}

async function main(): Promise<void> {
  scriptedLlm.responses = [{ text: 'window open' }]
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'open a window' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const windowAgent = (ctx.get('arborDriver') as {
      windowAgentOf(id: SessionId): Agent | undefined
    }).windowAgentOf(sessionId)
    check('window agent registered', windowAgent !== undefined,
      `window agent -> ${windowAgent?.id ?? 'none'}`)

    const userHeader = agent.session.header
    const windowHeader = windowAgent?.session.header
    check('window session is a subagent-origin session',
      windowHeader?.origin === 'subagent' && windowHeader.parentSession === sessionId,
      `window header: origin=${windowHeader?.origin} parentSession=${windowHeader?.parentSession}`)
    check('user session has no subagent origin', userHeader.origin === undefined,
      `user header: origin=${userHeader.origin ?? 'none'}`)

    check('window agent is owned by the user session agent',
      windowAgent !== undefined && ctx.agents.isOwnedBy(windowAgent.id, agent),
      `owned=${windowAgent === undefined ? 'n/a' : ctx.agents.isOwnedBy(windowAgent.id, agent)}`)
    check('window agent is not a registry root',
      windowAgent !== undefined && !ctx.agents.roots().some(root => root.id === windowAgent.id),
      `roots: ${ctx.agents.roots().map(root => root.id).join(', ')}`)
    check('user session agent is a registry root', ctx.agents.roots().some(root => root.id === agent.id),
      `roots: ${ctx.agents.roots().map(root => root.id).join(', ')}`)

    // The shipped rule, over the sessions this boot knows.
    const archived = new Set<SessionId>()
    const userVisible = sessionVisible(userHeader, sessionId, archived, 'default')
    const windowVisible = windowHeader === undefined
      ? false
      : sessionVisible(windowHeader, sessionId, archived, 'default')
    check('user session visible in the sidebar', userVisible, `user session ${sessionId} visible=${userVisible}`)
    check('window session hidden from the sidebar', !windowVisible,
      `window session ${windowAgent?.id ?? 'none'} visible=${windowVisible}`)
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
console.log(failures.length === 0 ? 'PROOF 3 OK' : `PROOF 3 FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
