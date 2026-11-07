/**
 * Proof 11: the workspace arbor's file tools really work in, and the refusal a
 * write the policy refuses really produces.
 *
 * B1's workspace gave every window a `DirectoryWorkspace` whose file tools used
 * `node:fs` and `spawn('/bin/sh')` on the host, so DSH's file policy did not
 * apply to them at all. B3's workspace routes everything through DSH's own
 * seams, and this proof checks that loop against the real sandbox, in
 * `read-only` mode so every refusal is real:
 *
 *  - the mount owns `exec`, `readFile` and `writeFile`, which is the seam
 *    arbor's `bash`/`read`/`write`/`edit` go through
 *    (`@4fu/arbor-tools`, `groups/files.js`);
 *  - the `<workspace>` section names the session's cwd and the mode that stands;
 *  - a `write` the sandbox refuses reaches the model as a refusal that carries
 *    the denial marker, the reason and the next action, and the file is not
 *    created;
 *  - a `bash` command runs in the session's cwd.
 *
 * The escalation half this proof used to carry is gone with the tool it
 * exercised: decisions table revision 2 drops DSH's sandbox for arbor sessions,
 * so there is no `sandbox_escalate` to ask through and no wider mode to grant.
 * B3b replaces the whole sandbox path — this proof with it — when it moves the
 * workspace onto arbor's own.
 *
 * Run: pnpm proof:sandbox
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  windowOf,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

/** One scripted model response. */
type Response = { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }

const NAME = 'arbor-spike-proof-11'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/**
 * One arbor session agent, warmed up with a turn of its own.
 *
 * DSH's session-title provider asks the model once per session, on the first
 * prompt (`session-title-first-prompt-llm`), and the scripted model answers it
 * from the same script — so a session that is about to run a scripted sequence
 * spends its first turn on the title and the sequence starts clean on the
 * second.
 */
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

/** Drive one session through one turn with the scripted responses given. */
async function drive(agent: Agent, task: string, responses: readonly Response[]): Promise<void> {
  scriptedLlm.responses = [...responses]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** One session's durable log, in order. */
function logOf(agent: Agent): { type: string; seq: number; data: unknown }[] {
  const log: { type: string; seq: number; data: unknown }[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) log.push({ type: event.type, seq, data: event.data })
  }
  return log
}

/** Every tool-result text one session's log carries, in order. */
function resultTexts(agent: Agent): string[] {
  return logOf(agent).filter(entry => entry.type === 'tool/result').flatMap(entry => {
    const message = (entry.data as { message?: { content?: readonly ContentBlock[] } }).message
    return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
  })
}

async function main(): Promise<void> {
  // Every refusal in this proof is real: the profile's own sandbox mode is
  // read-only. The base profile reads `DSH_PERMISSION_MODE ?? 'workspace-write'`
  // (`packages/bundle/base/cordis.patch.yml`, the `sandbox-policy` row), and the
  // arbor overlay rewires that row, so the mode is the deployment's own answer.
  process.env['DSH_PERMISSION_MODE'] = 'read-only'
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await mkdtemp(join(tmpdir(), 'arbor-sandbox-'))
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)

    // ---- the mount is the session's cwd, and it owns the three capabilities.
    const first = await createSession(ctx, project)
    await drive(first, 'write a note', [
      { toolCalls: [{ name: 'write', args: { path: 'note.txt', text: 'first attempt' } }] },
      { text: 'the write was refused' },
    ])
    const mount = await host.host.services.ensureWorkspace(windowOf(ctx, first.session.id)!)
    check('the mount is the session cwd itself', mount?.path === project,
      `mount path: ${mount?.path}; the session's cwd is ${project}`)
    check('the mount owns exec, readFile and writeFile',
      typeof mount?.exec === 'function' && typeof mount?.readFile === 'function' && typeof mount?.writeFile === 'function',
      `exec: ${typeof mount?.exec}, readFile: ${typeof mount?.readFile}, writeFile: ${typeof mount?.writeFile}`)

    // ---- the prompt says what is true.
    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(first.session.id) ?? ''
    check('the <workspace> section names the session cwd', prompt.includes(project),
      `the section names ${project}: ${prompt.includes(project)}`)
    check('the <workspace> section states the standing mode',
      prompt.includes('当前会话的沙箱模式是 read-only'),
      'the section names the mode it resolved for the session')
    check('the prompt names no escalation tool',
      !prompt.includes('sandbox_escalate'),
      'revision 2 drops DSH\'s sandbox for arbor sessions, so no tool asks for a wider mode')

    // ---- a refused write reaches the model as a refusal with a next action.
    const refused = resultTexts(first)
    check('the refused write carries the sandbox denial marker',
      refused.some(text => text.includes('[sandbox: file access denied under read-only mode]')),
      `tool results: ${JSON.stringify(refused)}`)
    check('the refusal names the next action',
      refused.some(text => text.includes('只读') && text.includes('向用户说明')),
      `tool results: ${JSON.stringify(refused)}`)
    check('the sandbox really refused the write', !existsSync(join(project, 'note.txt')),
      `note.txt exists: ${existsSync(join(project, 'note.txt'))}`)

    // ---- a command runs in the session's cwd.
    const commanded = await createSession(ctx, project)
    await drive(commanded, 'run pwd', [
      { toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
      { text: 'the command ran in the session cwd' },
    ])
    check('a bash command runs in the session cwd',
      resultTexts(commanded).some(text => text.includes(project)),
      `tool results: ${JSON.stringify(resultTexts(commanded))}`)
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
