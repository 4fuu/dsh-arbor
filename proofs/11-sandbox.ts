/**
 * Proof 11: arbor's own workspace over the shared folder, with no DSH sandbox.
 *
 * The owner's decision for arbor sessions reverses part of B3: arbor's tools run
 * on the host the way they do in standalone arbor, so the workspace is arbor's
 * own — ovnfs when its daemon starts, the plain-directory workspace otherwise,
 * rooted at the arbor shared folder under `DSH_HOME/arbor/shared`. There is no
 * DSH sandbox seam, no `sandbox_escalate` and no `fileToolsSandboxed`.
 *
 * This proof runs against the real `OvnfsWorkspace` and `OvnfsWorkspaceGroup`
 * (`@4fu/arbor-workspace-ovnfs`), driven through the model loop, with the ovnfs
 * stand-in on PATH (the real binary is not installed here; see `useOvnfsStub`).
 * It checks the whole method end to end:
 *
 *  - the host settled on the ovnfs backend and mounts the shared folder;
 *  - a window opens a checkout of a project subfolder (`workspace.checkout`),
 *    changes a file in it with its own `write`, and merges it back
 *    (`workspace.apply`), and the change shows in the project folder the DSH UI
 *    lists — the shared folder;
 *  - the `<workspace>` prompt section names the shared folder and the checkout
 *    method, and carries no sandbox line;
 *  - no `sandbox_escalate` tool and no sandbox wording appears in the prompt or
 *    the window's tool declarations.
 *
 * Run: pnpm proof:sandbox   (the package script name is unchanged)
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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

const NAME = 'arbor-spike-proof-11'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One arbor session agent, warmed up so its window is open. */
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

/** Every tool-result text one session's log carries, in order. */
function resultTexts(agent: Agent): string[] {
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type !== 'tool/result') continue
    const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
    for (const block of message?.content ?? []) {
      if (block.type === 'text') texts.push(block.text ?? '')
    }
  }
  return texts
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

    // ---- the host settled on ovnfs over the shared folder.
    check('the host runs the ovnfs workspace backend', host.workspaceBackend === 'ovnfs',
      `workspaceBackend: ${host.workspaceBackend}`)
    const shared = host.sharedFolder
    check('the shared folder is under the arbor data root',
      shared === join(host.dataRoot, 'shared'), `shared folder: ${shared}`)

    // ---- seed one project in the shared folder.
    const project = join(shared, 'app')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'hello.txt'), 'original', 'utf8')

    const agent = await createSession(ctx, shared)
    const window = windowOf(ctx, agent.session.id)!
    const checkoutName = `${window}-app`
    const checkoutPath = join(host.dataRoot, 'ovnfs', 'checkouts', checkoutName)

    // ---- a window opens a checkout, changes a file, and applies it back.
    await drive(agent, 'change the greeting', [
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.checkout({ name: ${JSON.stringify(checkoutName)}, dir: "app" })` } }] },
      { toolCalls: [{ name: 'write', args: { path: join(checkoutPath, 'hello.txt'), text: 'changed by the window' } }] },
      { toolCalls: [{ name: 'code_exec', args: { script: `return await workspace.apply({ name: ${JSON.stringify(checkoutName)} })` } }] },
      { text: 'the greeting is changed and applied' },
    ])
    const results = resultTexts(agent)

    check('the window opened a checkout of the project',
      existsSync(join(checkoutPath, 'hello.txt')),
      `checkout ${checkoutName} at ${checkoutPath}`)
    check('the checkout result named the checkout path',
      results.some(text => text.includes('已打开检出') && text.includes(checkoutPath)),
      `results: ${JSON.stringify(results)}`)
    check('the apply merged the change back',
      results.some(text => text.includes('已合回') && text.includes('应用 1 个')),
      `results: ${JSON.stringify(results)}`)
    check('the change shows in the project folder the DSH UI lists',
      existsSync(join(project, 'hello.txt'))
        && await readFile(join(project, 'hello.txt'), 'utf8') === 'changed by the window',
      `shared ${project}/hello.txt: ${existsSync(join(project, 'hello.txt')) ? await readFile(join(project, 'hello.txt'), 'utf8') : 'absent'}`)

    // ---- the prompt says what is true, and nothing about a sandbox.
    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(agent.session.id) ?? ''
    check('the <workspace> section names the shared folder',
      /<workspace>[\s\S]*<\/workspace>/.test(prompt) && prompt.includes(shared),
      `the section names ${shared}: ${prompt.includes(shared)}`)
    check('the <workspace> section carries no sandbox line',
      !prompt.includes('沙箱') && !/sandbox/i.test(prompt),
      'no sandbox wording in the prompt')
    check('the prompt declares no sandbox_escalate tool',
      !prompt.includes('sandbox_escalate'), 'no escalation tool in the prompt')

    // ---- the window's tool declarations carry no sandbox tool.
    const toolNames = host.backend.toolSpecs(window).map(tool => tool.name)
    check('the tool list declares no sandbox tool',
      !toolNames.some(name => /sandbox|escalate/i.test(name)),
      `tools: ${toolNames.join(', ')}`)
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
finishProof('PROOF 11', failures)
