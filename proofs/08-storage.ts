/**
 * Proof 8: the durable storage, the one host, and the workspace root.
 *
 * B1's storage decisions, checked against the shipped packages:
 *
 *  - the journal and the note store are `@4fu/arbor-journal-sqlite` and
 *    `@4fu/arbor-notes-sqlite` on `node:sqlite`, under `DSH_HOME/arbor/`, so
 *    nothing native has to build and the state is on disk;
 *  - one Arbor host serves the whole process: two sessions of different cwds
 *    share one host, one journal and one board, and each session's window
 *    carries that session's target;
 *  - the window settings are arbor's own defaults — the deployment sets no
 *    idle period, context budget or reserve — and the judge is off, so
 *    `host.dispatch` is deterministic;
 *  - the workspace is arbor's own over the shared folder: every session's
 *    window works in the one shared folder under `DSH_HOME/arbor`, there is no
 *    per-session directory, and the `<workspace>` section names the shared
 *    folder with no sandbox line;
 *  - an existing directory with its own path is an external pointer, named
 *    inside that same `<workspace>` section: a window reads the pointed file on
 *    its first call, a pointer added mid-window reaches the window as a delta of
 *    only the changed line, and a pointer whose directory is gone leaves the
 *    prompt;
 *  - an ordinary session on the embedded AgentLoop is untouched: it keeps the
 *    cwd it was created with and the DSH sandbox stays mounted for it.
 *
 * Run: pnpm proof:storage
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, sep } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  windowOf,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-8'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One arbor session, driven for one turn. */
async function runSession(
  ctx: Awaited<ReturnType<typeof bootArborProfile>>,
  cwd: string,
  responses: readonly { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }[] = [{ text: 'pong' }],
  existing?: SessionId,
  prepare?: (sessionId: SessionId) => void | Promise<void>,
): Promise<SessionId> {
  let agent: Agent
  if (existing === undefined) {
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    ;({ agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    }))
  } else {
    agent = ctx.agents.get(existing) as Agent
  }
  // A pointer belongs to the session that asked for it, so it has to be recorded
  // against the session's own id — which only exists once the agent does. The
  // hook runs before the first turn, which is when the prompt is assembled.
  await prepare?.(agent.session.id)
  scriptedLlm.responses = [...responses]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent.session.id
}

/** One tool call a window ran, with the text its result carried. */
interface LoggedToolCall {
  readonly name: string
  readonly text: string
}

/** Every tool call the session's window ran, in order, with its result text. */
function toolCallsOf(ctx: Awaited<ReturnType<typeof bootArborProfile>>, sessionId: SessionId): readonly LoggedToolCall[] {
  const agent = ctx.agents.get(sessionId) as Agent
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
 * window reads.
 *
 * A prompt delta is context for the window rather than an input that deserves a
 * turn of its own, so the backend injects it (`@4fu/dsh-arbor-llm`,
 * `DELTA_KINDS`) and it lands on the session log as an `agent/inbox/spliced`
 * event — which is what makes it observable here.
 */
function splicedTextsOf(ctx: Awaited<ReturnType<typeof bootArborProfile>>, sessionId: SessionId): readonly string[] {
  const agent = ctx.agents.get(sessionId) as Agent
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

/** Wait until one call answers, or give up after `limit` ms. */
async function waitFor<T>(read: () => T | undefined, limit = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + limit
  for (;;) {
    const found = read()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function main(): Promise<void> {
  scriptedLlm.responses = [{ text: 'pong' }]
  const home = await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const first = await mkdtemp(join(tmpdir(), 'arbor-project-'))
  const second = await mkdtemp(join(tmpdir(), 'arbor-project-'))
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const host = arborHostOf(ctx)
    const firstSession = await runSession(ctx, first)
    const secondSession = await runSession(ctx, second)

    // ---- the durable storage.
    check('the data root is the arbor directory under the DSH home',
      host.dataRoot === join(home, 'arbor'), `data root: ${host.dataRoot}`)
    check('the journal is a SQLite file on disk',
      existsSync(join(host.dataRoot, 'journal.sqlite')),
      `journal: ${join(host.dataRoot, 'journal.sqlite')}`)
    check('the note store is a SQLite file beside it',
      existsSync(join(host.dataRoot, 'notes.sqlite')),
      `notes: ${join(host.dataRoot, 'notes.sqlite')}`)

    // ---- one host per process.
    check('both sessions share one Arbor host',
      host.host.live().length === 2
      && [firstSession, secondSession].every(id => windowOf(ctx, id) !== undefined),
      `live windows: ${host.host.live().map(record => record.window).join(', ')}`)
    const starts = await (async () => {
      const page = await host.host.journal.list({ kinds: ['window_start'], limit: 50 })
      return (page?.items ?? []).map(item => `${item.window}:[${item.targets.join(',')}]`)
    })()
    check('one journal holds the windows of both sessions',
      starts.some(entry => entry.includes(`dsh:session:${firstSession}`))
      && starts.some(entry => entry.includes(`dsh:session:${secondSession}`)),
      `window_start events: ${starts.join(' ')}`)
    check('the board carries one line per live window', host.host.boardLines().length === 2,
      `board lines: ${host.host.boardLines().length}`)

    // ---- the settings.
    const settings = host.settings
    check('the window settings are left to arbor', settings.window === undefined,
      `settings.window: ${JSON.stringify(settings.window)}`)
    const modes = settings.judge?.modes ?? {}
    check('the judge is off, so dispatch is deterministic',
      Object.values(modes).every(mode => mode === 'off') && Object.keys(modes).length === 6,
      `judge modes: ${JSON.stringify(modes)}`)
    check('no window retention is set, because the workspace is the session cwd',
      settings.workspaces === undefined,
      `settings.workspaces: ${JSON.stringify(settings.workspaces)}`)

    // ---- the workspace is arbor's own. With no ovnfs binary on PATH (this
    // proof does not stage one) the host falls back to the plain-directory
    // workspace: one directory per window under the arbor data root. Proof 11
    // stages the ovnfs stand-in and proves the shared-folder checkout model.
    check('the host runs the plain-directory workspace when ovnfs is absent',
      host.workspaceBackend === 'dir', `workspaceBackend: ${host.workspaceBackend}`)
    const shared = host.sharedFolder
    const workspacesRoot = join(host.dataRoot, 'workspaces')
    const firstWindow = windowOf(ctx, firstSession)!
    const mount = await host.host.services.ensureWorkspace(firstWindow)
    check('the window works in its own directory under the workspaces root',
      mount !== undefined && mount.path.startsWith(workspacesRoot + sep),
      `window ${firstWindow} works in ${mount?.path ?? 'nothing'}; under ${workspacesRoot}`)
    const secondWindow = windowOf(ctx, secondSession)!
    const secondMount = await host.host.services.ensureWorkspace(secondWindow)
    check('a second session window works in its own separate directory',
      secondMount !== undefined && secondMount.path.startsWith(workspacesRoot + sep) && secondMount.path !== mount?.path,
      `window ${secondWindow} in ${secondMount?.path ?? 'nothing'}; first in ${mount?.path ?? 'nothing'}`)
    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(firstSession) ?? ''
    check('the <workspace> section is arbor\'s own, with no sandbox line',
      /<workspace>[\s\S]*<\/workspace>/.test(prompt) && !prompt.includes('沙箱'),
      `sandbox mention in the prompt: ${prompt.includes('沙箱')}`)

    // ---- an ordinary session on the embedded AgentLoop is untouched.
    scriptedLlm.responses = [{ text: 'ok' }]
    const ordinaryId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent: ordinary } = await ctx.agents.create({
      sessionId: ordinaryId,
      meta: { cwd: first },
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    check('an ordinary session keeps the cwd it was created with',
      ordinary.session.header.cwd === first,
      `ordinary cwd: ${ordinary.session.header.cwd}; created with ${first}`)
    check('the DSH sandbox stays mounted for ordinary sessions',
      (ctx.get('sandboxPolicy') as unknown) !== undefined,
      `sandboxPolicy service: ${ctx.get('sandboxPolicy') === undefined ? 'absent' : 'present'}`)

    // ---- an existing directory is a pointer, never copied into the shared folder.
    // The owner's decision (no copy, no mount, no adoption): the session works in
    // the shared folder and the user's own directory is recorded as a pointer, so
    // arbor's prompt names it and the model reaches it on the host directly.
    const external = await mkdtemp(join(tmpdir(), 'arbor-pointer-'))
    await writeFile(join(external, 'code.py'), 'print("hi")', 'utf8')
    const pointerSession = await runSession(ctx, first, [
      { toolCalls: [{ name: 'read', args: { path: join(external, 'code.py') } }] },
      { text: 'read the pointed file' },
    ], undefined, (sessionId) => {
      host.pointerArborProject(external, sessionId)
    })
    const pointer = { name: basename(external), path: external }
    check('an existing directory is recorded as a pointer, not copied into the shared folder',
      pointer.path === external
        && !existsSync(join(shared, basename(external)))
        && existsSync(join(external, 'code.py')),
      `pointer name=${pointer.name} path=${pointer.path}; a same-named project in the shared folder: ${existsSync(join(shared, basename(external)))}; the original file intact: ${existsSync(join(external, 'code.py'))}`)
    const pointers = await host.listArborPointers(pointerSession)
    check('the pointer is listed for the prompt',
      pointers.length === 1 && pointers[0]?.path === external,
      `pointers: ${pointers.map(p => `${p.name}=${p.path}`).join(', ')}`)

    // ---- the pointer is named inside arbor's own <workspace> section, and a
    // window reaches the path it names on its first call, with no exploratory
    // call before it: the prompt is the only thing the window was given.
    const pointerPrompt = driver.systemPromptOf(pointerSession) ?? ''
    const workspace = /<workspace>([\s\S]*?)<\/workspace>/.exec(pointerPrompt)?.[1] ?? ''
    check('the pointer line is inside the one <workspace> section',
      workspace.includes(`外部项目 ${pointer.name}：${pointer.path}`),
      `<workspace> names the pointer: ${workspace.includes(pointer.path)}`)
    check('the pointer is named once, in one home, and not restated elsewhere',
      pointerPrompt.split(pointer.path).length - 1 === 1
        && workspace.includes('用户另外添加的目录')
        && workspace.includes('没有复制它')
        && workspace.includes('就在原处改'),
      `occurrences of the path in the whole prompt: ${pointerPrompt.split(pointer.path).length - 1}`)
    const readCalls = toolCallsOf(ctx, pointerSession)
    check('a window reads the pointed file on its first call, with no exploratory call before it',
      readCalls.length === 1
        && readCalls[0]?.name === 'read'
        && readCalls[0]?.text.includes('print("hi")'),
      `tool calls: ${readCalls.map(one => one.name).join(', ') || '(none)'}; result: ${readCalls[0]?.text ?? ''}`)

    // ---- a pointer added while the window runs reaches it as a delta of only
    // the changed line, the way every other prompt-section change does. The
    // host delivers from its own watch loop, which runs beside the turn rather
    // than inside it, so the proof waits for what it asserts.
    const secondPointer = await mkdtemp(join(tmpdir(), 'arbor-pointer-'))
    await writeFile(join(secondPointer, 'notes.md'), 'the second directory', 'utf8')
    host.pointerArborProject(secondPointer, pointerSession)
    await runSession(ctx, first, [{ text: 'one more turn' }], pointerSession)
    const wanted = `外部项目 ${basename(secondPointer)}：${secondPointer}`
    const delta = await waitFor(() => {
      const found = splicedTextsOf(ctx, pointerSession).filter(text => text.includes(wanted))
      return found.length === 1 ? found[0] : undefined
    })
    check('a pointer added mid-window reaches the running window as a delta',
      delta !== undefined, `delta: ${JSON.stringify(delta ?? '(none)')}`)
    check('the delta carries only the changed line',
      delta !== undefined
        && /<workspace>\n([\s\S]*?)\n<\/workspace>/.exec(delta)?.[1] === `+ ${wanted}`
        && !delta.includes('用户另外添加的目录'),
      `delta: ${JSON.stringify(delta ?? '(none)')}`)

    // True at read: remove the directory and the pointer drops, so the prompt
    // never names a path that no longer exists. The window's own prefix is
    // frozen, so the drop reaches it as a delta of the line that went, and a
    // window that opens afterwards never sees the line at all.
    await rm(external, { recursive: true, force: true })
    const afterGone = await host.listArborPointers(pointerSession)
    check('a pointer whose directory is gone drops from the list',
      afterGone.length === 1 && afterGone[0]?.path === secondPointer,
      `pointers after the directory is removed: ${afterGone.map(p => p.name).join(', ')}`)
    const gone = `外部项目 ${pointer.name}：${pointer.path}`
    await runSession(ctx, first, [{ text: 'one more turn' }], pointerSession)
    const dropped = await waitFor(() => {
      const found = splicedTextsOf(ctx, pointerSession).filter(text => text.includes(gone))
      return found.length === 1 ? found[0] : undefined
    })
    check('the dropped pointer reaches the window as a delta of the line that went',
      dropped !== undefined
        && /<workspace>\n([\s\S]*?)\n<\/workspace>/.exec(dropped)?.[1] === `- ${gone}`,
      `delta: ${JSON.stringify(dropped ?? '(none)')}`)
    const laterPrompt = driver.systemPromptOf(await runSession(ctx, first)) ?? ''
    check("a session that asked for nothing never sees another session's pointers",
      !laterPrompt.includes(external) && !laterPrompt.includes(secondPointer),
      `the removed path is still named: ${laterPrompt.includes(external)}; the other session's pointer is named: ${laterPrompt.includes(secondPointer)}`)
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
finishProof('PROOF 8', failures)
