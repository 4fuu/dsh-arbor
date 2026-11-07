/**
 * Proof 11: arbor's own file tools run inside DSH's sandbox.
 *
 * B1's workspace gave every window a `DirectoryWorkspace` whose file tools used
 * `node:fs` and `spawn('/bin/sh')` on the host, so DSH's file policy did not
 * apply to them at all. B3's workspace routes everything through DSH's own
 * seams, and this proof checks the whole loop against the real sandbox, in
 * `read-only` mode so every refusal is real:
 *
 *  - the mount owns `exec`, `readFile` and `writeFile`, which is the seam
 *    arbor's `bash`/`read`/`write`/`edit` go through
 *    (`@4fu/arbor-tools`, `groups/files.js`), and `ctx.arborHost
 *    .fileToolsSandboxed` is the capability fact the prompt bridge reads;
 *  - the `<workspace>` section names the session's cwd and the mode that
 *    stands, because a line that claimed confinement the tools do not have is a
 *    lie the model would act on;
 *  - a `write` the sandbox refuses reaches the model as a refusal that carries
 *    the denial marker and the next action, and the file is not created;
 *  - a `sandbox_escalate` asks through DSH's approval — the ask lands on the
 *    user session's agent inside its open turn, the audit pair is on that
 *    session's log — and the grant lets the same `write` through;
 *  - a rejected escalation reaches the model as a refusal and changes nothing;
 *  - an escalation that is not strictly wider is refused without asking anybody;
 *  - a `bash` command runs in the session's cwd.
 *
 * Run: pnpm proof:sandbox
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, mkdtemp } from 'node:fs/promises'
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

/** One approval answerer run, recorded for the assertions. */
const answererRuns: { agentId: string; toolName: string; reason: string; outcome: string }[] = []

/** Register an answerer on one agent's scope, the way a UI answerer does. */
function answerOn(agent: Agent, outcome: 'allowed-once' | 'rejected'): () => void {
  return agent.ctx.on('approval/request', async (req) => {
    answererRuns.push({ agentId: req.agent.id, toolName: req.toolName, reason: req.reason ?? '', outcome })
    return outcome
  })
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

/** Whether one seq range sits between a turn/start and its turn/end. */
function turnEnclosed(log: { type: string; seq: number }[], from: number, to: number): boolean {
  const start = log.findLast(entry => entry.type === 'turn/start' && entry.seq < from)
  const end = log.find(entry => entry.type === 'turn/end' && entry.seq > to)
  return start !== undefined && end !== undefined && start.seq < from && to < end.seq
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

    // ---- the capability the prompt bridge gates on.
    const hostService = ctx.get('arborHost') as { fileToolsSandboxed: boolean }
    check('the host reports arbor file tools as sandboxed',
      hostService.fileToolsSandboxed === true,
      `ctx.arborHost.fileToolsSandboxed: ${hostService.fileToolsSandboxed}`)

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
    check('the <tools> section declares sandbox_escalate', prompt.includes('sandbox_escalate'),
      'the escalation tool is in the prompt')

    // ---- a refused write reaches the model as a refusal with a next action.
    const refused = resultTexts(first)
    check('the refused write carries the sandbox denial marker',
      refused.some(text => text.includes('[sandbox: file access denied under read-only mode]')),
      `tool results: ${JSON.stringify(refused)}`)
    check('the refusal names the next action',
      refused.some(text => text.includes('sandbox_escalate') && text.includes('只读')),
      `tool results: ${JSON.stringify(refused)}`)
    check('the sandbox really refused the write', !existsSync(join(project, 'note.txt')),
      `note.txt exists: ${existsSync(join(project, 'note.txt'))}`)

    // ---- an escalation asks through DSH's approval, and the grant lands.
    const escalated = await createSession(ctx, project)
    const stopAnswerer = answerOn(escalated, 'allowed-once')
    await drive(escalated, 'ask for a wider mode, then write', [
      { toolCalls: [{ name: 'sandbox_escalate', args: { mode: 'workspace-write', justification: 'the note has to be written beside the project' } }] },
      { toolCalls: [{ name: 'write', args: { path: 'note.txt', text: 'written after the grant' } }] },
      { text: 'the note is written' },
    ])
    stopAnswerer()

    check('the escalation ask reached the user session agent',
      answererRuns.length === 1 && answererRuns[0]?.agentId === escalated.id
        && answererRuns[0]?.toolName === 'sandbox_escalate',
      `answerer runs: ${JSON.stringify(answererRuns)}`)
    check('the ask carried the model\'s justification',
      (answererRuns[0]?.reason ?? '').includes('the note has to be written beside the project'),
      `reason: ${answererRuns[0]?.reason}`)
    const escalatedLog = logOf(escalated)
    const asked = escalatedLog.filter(entry => entry.type === 'approval/asked')
    const decided = escalatedLog.filter(entry => entry.type === 'approval/decided')
    check('the approval audit pair is on the session log', asked.length === 1 && decided.length === 1,
      `asked=${asked.length} decided=${decided.length}`)
    check('the audit pair sits inside the open turn',
      turnEnclosed(escalatedLog, asked[0]?.seq ?? -1, decided[0]?.seq ?? -1),
      `asked at ${asked[0]?.seq}, decided at ${decided[0]?.seq}`)

    const escalatedResults = resultTexts(escalated)
    check('the grant is reported to the model',
      escalatedResults.some(text => text.includes('已批准把沙箱模式提到 workspace-write')),
      `tool results: ${JSON.stringify(escalatedResults)}`)
    check('the write after the grant succeeded', existsSync(join(project, 'note.txt')),
      `note.txt exists: ${existsSync(join(project, 'note.txt'))}`)
    check('the write after the grant wrote what the model sent',
      existsSync(join(project, 'note.txt'))
        && await readFile(join(project, 'note.txt'), 'utf8') === 'written after the grant',
      `note.txt: ${existsSync(join(project, 'note.txt')) ? await readFile(join(project, 'note.txt'), 'utf8') : 'absent'}`)

    // ---- a rejected escalation reaches the model as a refusal.
    const rejected = await createSession(ctx, project)
    const stopRejecting = answerOn(rejected, 'rejected')
    await drive(rejected, 'ask for a wider mode', [
      { toolCalls: [{ name: 'sandbox_escalate', args: { mode: 'danger-full-access', justification: 'the note has to be written outside the project' } }] },
      { text: 'the escalation was refused' },
    ])
    stopRejecting()
    const rejectedResults = resultTexts(rejected)
    check('the rejected escalation reaches the model as a refusal',
      rejectedResults.some(text => text.includes('用户拒绝了把沙箱模式提到 danger-full-access')),
      `tool results: ${JSON.stringify(rejectedResults)}`)
    check('the rejected escalation changed nothing',
      await readFile(join(project, 'note.txt'), 'utf8') === 'written after the grant',
      'note.txt is still what the granted write left')

    // ---- an escalation outside the target vocabulary is refused without an ask.
    // `read-only` is the floor and nothing escalates to it (`ESCALATION_TARGETS`,
    // `@deepseek-ai/dsh-sandbox`), so asking for it is a malformed ask rather
    // than one the user should be shown.
    const floor = await createSession(ctx, project)
    const asksBefore = answererRuns.length
    await drive(floor, 'ask for the floor mode', [
      { toolCalls: [{ name: 'sandbox_escalate', args: { mode: 'read-only', justification: 'no change is needed' } }] },
      { text: 'the ask was pointless' },
    ])
    check('an escalation to the floor is refused without an ask',
      answererRuns.length === asksBefore
        && resultTexts(floor).some(text => text.includes('mode 只能是 workspace-write 或 danger-full-access')),
      `answerer runs: ${answererRuns.length}; tool results: ${JSON.stringify(resultTexts(floor))}`)

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
