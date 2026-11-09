/**
 * Proof 17: the project the user picked is named once in `<workspace>`, and a
 * re-routed session looks exactly like a session created under arbor.
 *
 * The live run on b3c made the gap visible: the user picked `web-app` in the
 * composer, the window worked in its own directory, and the model answered
 * "tell me the path" — trial and error the prompt should have prevented. So the
 * session's project is stated once, inside arbor's own `<workspace>`: its name,
 * where it is, and how the window reaches it, with the reach line the workspace
 * implementation's own (a checkout under ovnfs, the absolute path under the
 * plain-directory fallback, which is the backend this proof runs because it
 * stages no ovnfs binary).
 *
 * The second half is the asymmetry the re-route left behind: a session created
 * under arbor had its cwd resolved into the shared folder, while a session that
 * selected arbor afterwards kept the directory it was created in. Both paths now
 * resolve the same way, so the model, the cwd display and the project line read
 * one answer — including after a restart.
 *
 *  A. a session opened on a project names it once, and the window's first call
 *     goes straight to that project's file with no exploratory call before it;
 *  B. a session that selects arbor on the same project names the same line and
 *     ends up with the same cwd, which is what makes the two paths alike;
 *  C. a session that named no project has no project line at all;
 *  D. the project reaches a running window as a delta of only the changed line
 *     when the session's project moves before its first turn;
 *  E. a restart brings the session back on the same cwd and the same line.
 *
 * Run: pnpm proof:project-section
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
  windowOf,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-17'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
// The roster a deployment with a preset picker has, so a pick is committed the
// way the web hero commits it.
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))

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
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Every tool call the session's window ran, in order, with its result text. */
function toolCallsOf(sessionId: SessionId): readonly { name: string; text: string }[] {
  const agent = ctx!.agents.get(sessionId) as Agent
  const names: string[] = []
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type === 'tool/call') {
      names.push((event.data as { name?: string }).name ?? '')
    } else if (event?.type === 'tool/result') {
      const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
      texts.push((message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    }
  }
  return names.map((name, index) => ({ name, text: texts[index] ?? '' }))
}

/**
 * Every delivery the host spliced into the session's inbox, as the text the
 * window reads: a prompt delta is context for the window rather than an input
 * that deserves a turn of its own, so the backend injects it and it lands on the
 * session log as an `agent/inbox/spliced` event.
 */
function splicedTextsOf(sessionId: SessionId): readonly string[] {
  const agent = ctx!.agents.get(sessionId) as Agent
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type !== 'agent/inbox/spliced') continue
    const inserted = (event.data as { inserted?: readonly { content?: readonly { type: string; text?: string }[] }[] }).inserted ?? []
    for (const message of inserted) {
      texts.push(...(message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    }
  }
  return texts
}

/** Wait until one call answers something other than undefined, or give up. */
async function waitFor<T>(read: () => T | undefined, limit = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + limit
  for (;;) {
    const found = read()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Commit a preset pick the way the web hero does, and wait for the driver to follow it. */
async function selectPreset(agent: Agent, preset: string): Promise<Agent> {
  const presets = (ctx as unknown as { agentPresets?: { select(agent: Agent, id: string): Promise<string> } }).agentPresets
  await presets!.select(agent, preset)
  return await waitFor(() => {
    const current = ctx!.agents.get(agent.id) as Agent | undefined
    return current !== undefined && current !== agent ? current : undefined
  }) ?? agent
}

/** Boot the headless profile with every overlay this proof needs. */
async function boot(): Promise<ProofContext> {
  return await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay],
  })
}

async function main(): Promise<void> {
  // The plain-directory workspace is the one this proof's reach line and delta
  // assertions describe; keep the orb's ovnfs off PATH (proof 20 is ovnfs).
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin'
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await boot()
  const host = arborHostOf(ctx)
  const shared = host.sharedFolder
  const project = join(shared, 'web-app')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'index.html'), '<h1>web app</h1>', 'utf8')
  const other = join(shared, 'api-service')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'main.py'), 'print("api")', 'utf8')

  // ---- A. a session created on a project names it, and the window's first call
  // goes straight to the file the line named. The scripted call is the one a
  // model reading the prompt makes: the project's own file, at the path the
  // prompt named, with nothing before it.
  const created = await createSession(project, 'arbor')
  await turn(created, [
    { toolCalls: [{ name: 'read', args: { path: join(project, 'index.html') } }] },
    { text: 'read the project file' },
  ])
  const createdWorkspace = workspaceOf(created.id)
  const projectLine = `当前项目 web-app：${project}`
  check('a session opened on a project names it once in <workspace>',
    createdWorkspace.includes(projectLine)
      && createdWorkspace.split(projectLine).length - 1 === 1,
    `<workspace> names the project: ${createdWorkspace.includes(projectLine)}`)
  check('the project line says how the window reaches it',
    createdWorkspace.includes(`它在共享目录里，路径就是 ${project}；本窗口另有自己的工作目录，按这个绝对路径直接读写该项目。`),
    `the reach line is present: ${createdWorkspace.includes('按这个绝对路径直接读写该项目')}`)
  const createdCalls = toolCallsOf(created.id)
  check("the window's first call goes straight to the project's files",
    createdCalls.length === 1
      && createdCalls[0]?.name === 'read'
      && createdCalls[0]?.text.includes('<h1>web app</h1>'),
    `tool calls: ${createdCalls.map(one => one.name).join(', ') || '(none)'}; result: ${createdCalls[0]?.text ?? ''}`)
  check('the session the project line names is the one whose window opened',
    windowOf(ctx, created.id) !== undefined,
    `window: ${windowOf(ctx, created.id) ?? '(none)'}`)

  // ---- B. the re-routed path names the same project, in the same shape, and the
  // session's cwd is the one a created-under-arbor session has.
  const picked = await createSession(project)
  const rerouted = await selectPreset(picked, 'arbor')
  await turn(rerouted, [{ text: 'pong' }])
  check('a session that selected arbor names the same project line',
    workspaceOf(picked.id).includes(projectLine),
    `<workspace> names the project: ${workspaceOf(picked.id).includes(projectLine)}`)
  check('the re-routed session and the created one agree on the cwd',
    rerouted.session.header.cwd === created.session.header.cwd,
    `re-routed cwd: ${rerouted.session.header.cwd}; created cwd: ${created.session.header.cwd}`)

  // ---- C. a session that named no project has no project line. The shared
  // folder itself is "no specific project yet", so the implementation's own
  // lines are the whole answer.
  const plain = await createSession(shared, 'arbor')
  await turn(plain, [{ text: 'pong' }])
  check('a session with no project has no project line',
    !workspaceOf(plain.id).includes('当前项目') && workspaceOf(plain.id).includes('workspace.keep'),
    `<workspace> of a project-less session: ${JSON.stringify(workspaceOf(plain.id).slice(0, 60))}`)

  // ---- D. the project reaches a running window as a delta of only the changed
  // lines when the session's directory moves. DSH's own `working-directory`
  // service is what moves a session's directory — it appends
  // `working-directory/change`, which is the event the driver reads the
  // projection from — and the window keeps working where it works: only the
  // project line moves.
  const moving = await createSession(project, 'arbor')
  await turn(moving, [{ text: 'first turn' }])
  check('the window opened naming the project it was opened on',
    workspaceOf(moving.id).includes(projectLine),
    `<workspace> names the project: ${workspaceOf(moving.id).includes(projectLine)}`)
  moving.session.append('working-directory/change', { cwd: other })
  await turn(moving, [{ text: 'second turn' }])
  // A window's prefix is frozen when it opens, so the section it opened with is
  // what it still holds: the move reaches it as a delta, never as a rewrite.
  check('the running window keeps the prefix it opened with',
    workspaceOf(moving.id).includes(projectLine)
      && !workspaceOf(moving.id).includes('当前项目 api-service'),
    `<workspace> still names the project it opened on: ${workspaceOf(moving.id).includes(projectLine)}`)
  const wanted = [
    `- ${projectLine}`,
    `- 它在共享目录里，路径就是 ${project}；本窗口另有自己的工作目录，按这个绝对路径直接读写该项目。`,
    `+ 当前项目 api-service：${other}`,
    `+ 它在共享目录里，路径就是 ${other}；本窗口另有自己的工作目录，按这个绝对路径直接读写该项目。`,
  ].join('\n\n')
  const delta = await waitFor(() => {
    const found = splicedTextsOf(moving.id).filter(text => text.includes(`当前项目 api-service：${other}`))
    return found.length === 1 ? found[0] : undefined
  })
  const body = delta === undefined ? '' : /<workspace>\n([\s\S]*?)\n<\/workspace>/.exec(delta)?.[1] ?? ''
  check('the moved project reaches the running window as a delta of only the changed lines',
    body === wanted,
    `delta: ${JSON.stringify(body)}`)
  check('the delta restates nothing the window already has',
    delta !== undefined && !delta.includes('你的工作区是本主机上的一个目录'),
    `the delta carries the implementation's own method lines: ${delta?.includes('你的工作区是本主机上的一个目录')}`)

  // ---- E. a restart brings the session back on the same cwd and the same line.
  await ctx.fiber.dispose().catch(() => {})
  ctx = await boot()
  const resumed = await ctx.agents.resume({
    resumeSessionId: created.id,
    agentOptions: { ...SCRIPTED_SELECTION },
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  await turn(resumed.agent, [{ text: 'pong' }])
  check('a restart brings the session back on the same project',
    resumed.agent.session.header.cwd === created.session.header.cwd
      && workspaceOf(created.id).includes(projectLine),
    `resumed cwd: ${resumed.agent.session.header.cwd}; the project line is back: ${workspaceOf(created.id).includes(projectLine)}`)
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
  finishProof('project-section', failures)
}
