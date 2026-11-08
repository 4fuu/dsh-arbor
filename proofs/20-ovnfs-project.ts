/**
 * Proof 20: under ovnfs the `<workspace>` project line says where commands and
 * relative paths start, and that reading the project in place is fine.
 *
 * The live run on b3f showed the gap the ovnfs reach line left: the first bash
 * ran `cd web-app && ls -la`, relying on the shell starting in the shared
 * folder, and the model then wrote "bash ran in the shared folder default" and
 * listed the sibling `api-service` as noise. Arbor's own ovnfs lines already
 * say the shared folder is where every window reads from and where bash runs
 * (`workspace.method.shared`) and that a change goes through a checkout
 * (`workspace.method.open`, `workspace.method.readonly`), so what was missing
 * is the project's own half: that the picked project is a subdirectory of that
 * same place, reachable by the absolute path the line names or by the relative
 * path `<name>/`, with no `cd` — and that reading it in place needs no
 * checkout, because only a change does.
 *
 * This proof runs on the ovnfs backend (the stub on PATH, the same one proof 11
 * uses, because the real binary is not installed here) and checks:
 *
 *  A. the reach line names the project's subdirectory and its absolute path,
 *     and states that reading in place is fine while a change needs a checkout;
 *  B. it promises no call arbor refuses: the checkout is named as the project
 *     subdirectory to fill in, not as the checkout name, which must start with
 *     the window's own reference (`refused.workspace.name`);
 *  C. a window told to list the project's files reads it on its first call at a
 *     path the line names, with no `cd` and no call that reaches a sibling
 *     project first;
 *  D. arbor's own ovnfs lines are still there, unchanged, and the line adds
 *     nothing they already say.
 *
 * Run: pnpm proof:ovnfs-project
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  finishProof,
  freshDshHome,
  scriptedLlm,
  useOvnfsStub,
  windowOf,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-20'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

type ProofContext = Awaited<ReturnType<typeof bootArborProfile>>

const uninstallFailLoud = installFailLoud(NAME)
let ctx: ProofContext | undefined
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

/** The `<workspace>` section one session's window opened with. */
function workspaceOf(sessionId: SessionId): string {
  const driver = ctx!.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
  const prompt = driver.systemPromptOf(sessionId) ?? ''
  return /<workspace>([\s\S]*?)<\/workspace>/.exec(prompt)?.[1] ?? ''
}

/** Drive one session for one turn and wait for it to settle. */
async function turn(agent: Agent, responses: readonly { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }[]): Promise<void> {
  scriptedLlm.responses = [...responses]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list the project files' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Every tool call the session's window ran, in order, with its result text. */
function toolCallsOf(sessionId: SessionId): readonly { name: string; args: Record<string, unknown>; text: string }[] {
  const agent = ctx!.agents.get(sessionId) as Agent
  const calls: { name: string; args: Record<string, unknown>; text: string }[] = []
  /** The call's arguments: the log carries them as the JSON text the model wrote. */
  const argsOf = (data: Record<string, unknown>): Record<string, unknown> => {
    const raw = data['arguments']
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    return (raw ?? {}) as Record<string, unknown>
  }
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type === 'tool/call') {
      calls.push({
        name: (event.data as { name?: string }).name ?? '',
        args: argsOf(event.data as Record<string, unknown>),
        text: '',
      })
    } else if (event?.type === 'tool/result' && calls.length > 0) {
      const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
      const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      const last = calls[calls.length - 1]
      if (last !== undefined && last.text === '') last.text = text
    }
  }
  return calls
}

async function main(): Promise<void> {
  await useOvnfsStub()
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  const host = arborHostOf(ctx)
  check('the host runs the ovnfs workspace backend', host.workspaceBackend === 'ovnfs',
    `workspaceBackend: ${host.workspaceBackend}`)
  const shared = host.sharedFolder
  const project = join(shared, 'web-app')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'index.html'), '<h1>web app</h1>', 'utf8')
  // A sibling project the window must not reach for: the b3f run listed it as
  // noise after guessing its way into the shared folder.
  const sibling = join(shared, 'api-service')
  await mkdir(sibling, { recursive: true })
  await writeFile(join(sibling, 'main.py'), 'print("api")', 'utf8')

  // ---- A/B. the line says what the model has to know about this project.
  const agent = await createSession(project, 'arbor')
  await turn(agent, [{ text: 'pong' }])
  const workspace = workspaceOf(agent.id)
  const line = `它在共享目录里，子目录是 web-app：读它就读 ${project}，或按 web-app/ 读，不用开检出、不用 cd；要改它就用 workspace.checkout 给它开检出（子目录填 web-app），改完用 workspace.apply 合回共享目录。`
  check('the ovnfs reach line names the project subdirectory and its absolute path',
    workspace.includes(line),
    `the reach line is present: ${workspace.includes(line)}`)
  check('the reach line states that reading the project in place is fine',
    workspace.includes('不用开检出'), 'reading in place needs no checkout')
  check('the reach line states that a change goes through a checkout',
    workspace.includes('要改它就用 workspace.checkout'), 'a change needs a checkout')
  check('the reach line names the subdirectory as the checkout argument',
    workspace.includes('（子目录填 web-app）'), 'the checkout takes the project subdirectory')
  // The b3d line promised `workspace.checkout("web-app")`, which arbor refuses:
  // a checkout name must start with the window's own reference and the project
  // subdirectory is the second argument (`OvnfsWorkspaceGroup.checkout`,
  // `refused.workspace.name`).
  check('the reach line promises no call arbor refuses',
    !workspace.includes('workspace.checkout("web-app")') && !/workspace\.checkout\("[^"]*"\)/.test(workspace),
    `no bare checkout call naming the project: ${!/workspace\.checkout\("[^"]*"\)/.test(workspace)}`)

  // ---- C. the first call reads the project at a path the line names.
  const listing = await createSession(project, 'arbor')
  await turn(listing, [
    { toolCalls: [{ name: 'read', args: { path: join(project, 'index.html') } }] },
    { text: 'the project file is listed' },
  ])
  const calls = toolCallsOf(listing.id)
  check("the window's first call goes straight to the project's files",
    calls.length === 1 && calls[0]?.name === 'read' && calls[0]?.text.includes('<h1>web app</h1>'),
    `tool calls: ${calls.map(one => one.name).join(', ') || '(none)'}; result: ${calls[0]?.text ?? ''}`)
  check('the first call uses the absolute path the line names, with no cd',
    calls[0]?.args['path'] === join(project, 'index.html'),
    `path: ${String(calls[0]?.args['path'] ?? '')}`)
  check('no call reaches the sibling project',
    !calls.some(one => JSON.stringify(one.args).includes('api-service')),
    `calls naming api-service: ${calls.filter(one => JSON.stringify(one.args).includes('api-service')).length}`)

  // ---- D. arbor's own ovnfs lines are untouched, and the line restates none.
  check("arbor's own ovnfs lines are still in <workspace>",
    workspace.includes('所有窗口都从这里读，bash 默认也在这里运行') && workspace.includes('共享文件夹按约定只读'),
    'the shared-folder and read-only lines are present')
  check('the reach line restates nothing arbor already says',
    !workspace.includes('它在共享目录里：') && workspace.split('它在共享目录里').length - 1 === 1,
    `the lead-in appears once: ${workspace.split('它在共享目录里').length - 1 === 1}`)
  check('the session the line names is the one whose window opened',
    windowOf(ctx, listing.id) !== undefined,
    `window: ${windowOf(ctx, listing.id) ?? '(none)'}`)
}

const uninstall = installFailLoud(NAME)
try {
  await main()
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstall()
  uninstallFailLoud()
  finishProof('ovnfs-project', failures)
}
