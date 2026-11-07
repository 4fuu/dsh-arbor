/**
 * Proof 14: two windows on one project do not collide.
 *
 * ovnfs gives every window its own copy-on-write checkout of the project
 * subfolder it needs, so two windows working on the same project at once do not
 * see each other's in-progress changes and neither clobbers the other. This
 * proof drives two arbor sessions (two windows) through the real `OvnfsWorkspace`
 * against the ovnfs stand-in, and checks the isolation and the merge:
 *
 *  - each window opens a separate checkout of the same project `app`;
 *  - window c1 changes one file, window c2 changes another, and before either
 *    applies, c1's checkout holds only c1's change and c2's only c2's — the
 *    checkouts are separate directories, so the concurrent work does not
 *    interfere;
 *  - after both apply, the shared project folder holds both changes.
 *
 * Run: pnpm proof:windows
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  useOvnfsStub,
  windowOf,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

type Response = { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }

const NAME = 'arbor-spike-proof-14'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function createSession(ctx: Context, cwd: string): Promise<Agent> {
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd, agentPreset: 'arbor' },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  scriptedLlm.responses = [{ text: 'warmed up' }]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

async function drive(agent: Agent, task: string, responses: readonly Response[]): Promise<void> {
  scriptedLlm.responses = [...responses]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function main(): Promise<void> {
  await useOvnfsStub()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    check('the host runs the ovnfs workspace backend', host.workspaceBackend === 'ovnfs',
      `workspaceBackend: ${host.workspaceBackend}`)
    const shared = host.sharedFolder
    const project = join(shared, 'app')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'README.md'), 'the shared project', 'utf8')

    const first = await createSession(ctx, shared)
    const second = await createSession(ctx, shared)
    const firstWindow = windowOf(ctx, first.session.id)!
    const secondWindow = windowOf(ctx, second.session.id)!
    const firstCheckout = join(host.dataRoot, 'ovnfs', 'checkouts', `${firstWindow}-app`)
    const secondCheckout = join(host.dataRoot, 'ovnfs', 'checkouts', `${secondWindow}-app`)

    // ---- each window opens its own checkout and changes its own file, no apply yet.
    await drive(first, 'add a first file', [
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.checkout({ name: ${JSON.stringify(`${firstWindow}-app`)}, dir: "app" })` } }] },
      { toolCalls: [{ name: 'write', args: { path: join(firstCheckout, 'first.txt'), text: 'from the first window' } }] },
      { text: 'first file written in the first checkout' },
    ])
    await drive(second, 'add a second file', [
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.checkout({ name: ${JSON.stringify(`${secondWindow}-app`)}, dir: "app" })` } }] },
      { toolCalls: [{ name: 'write', args: { path: join(secondCheckout, 'second.txt'), text: 'from the second window' } }] },
      { text: 'second file written in the second checkout' },
    ])

    check('the two windows opened separate checkouts',
      firstCheckout !== secondCheckout && existsSync(firstCheckout) && existsSync(secondCheckout),
      `first: ${firstCheckout}; second: ${secondCheckout}`)
    check('the first checkout holds only the first window\'s change',
      existsSync(join(firstCheckout, 'first.txt')) && !existsSync(join(firstCheckout, 'second.txt')),
      `first.txt: ${existsSync(join(firstCheckout, 'first.txt'))}; second.txt in first checkout: ${existsSync(join(firstCheckout, 'second.txt'))}`)
    check('the second checkout holds only the second window\'s change',
      existsSync(join(secondCheckout, 'second.txt')) && !existsSync(join(secondCheckout, 'first.txt')),
      `second.txt: ${existsSync(join(secondCheckout, 'second.txt'))}; first.txt in second checkout: ${existsSync(join(secondCheckout, 'first.txt'))}`)
    check('neither change reached the shared project before apply',
      !existsSync(join(project, 'first.txt')) && !existsSync(join(project, 'second.txt')),
      `shared first.txt: ${existsSync(join(project, 'first.txt'))}; shared second.txt: ${existsSync(join(project, 'second.txt'))}`)

    // ---- both apply; the shared project ends up with both changes.
    await drive(first, 'apply the first checkout', [
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.apply({ name: ${JSON.stringify(`${firstWindow}-app`)} })` } }] },
      { text: 'applied' },
    ])
    await drive(second, 'apply the second checkout', [
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.apply({ name: ${JSON.stringify(`${secondWindow}-app`)} })` } }] },
      { text: 'applied' },
    ])
    check('after both apply the shared project holds both changes',
      existsSync(join(project, 'first.txt')) && existsSync(join(project, 'second.txt'))
        && existsSync(join(project, 'README.md')),
      `shared: first.txt=${existsSync(join(project, 'first.txt'))}, second.txt=${existsSync(join(project, 'second.txt'))}, README.md=${existsSync(join(project, 'README.md'))}`)
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
finishProof('PROOF 14', failures)
