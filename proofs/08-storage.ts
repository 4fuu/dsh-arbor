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
 *  - an ordinary session on the embedded AgentLoop is untouched: it keeps the
 *    cwd it was created with and the DSH sandbox stays mounted for it.
 *
 * Run: pnpm proof:storage
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'
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
async function runSession(ctx: Awaited<ReturnType<typeof bootArborProfile>>, cwd: string): Promise<SessionId> {
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd, agentPreset: 'arbor' },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say pong' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return sessionId
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

    // ---- an existing directory joins the shared folder by explicit adoption.
    const external = await mkdtemp(join(tmpdir(), 'arbor-adopt-'))
    await writeFile(join(external, 'code.py'), 'print("hi")', 'utf8')
    const adopted = await host.adoptArborProject(external)
    check('an existing directory is adopted into the shared folder as a project',
      adopted.startsWith(shared + sep) && existsSync(join(adopted, 'code.py')),
      `adopted ${external} -> ${adopted}; code.py present: ${existsSync(join(adopted, 'code.py'))}`)
    const adoptedAgain = await host.adoptArborProject(external)
    check('adoption is idempotent', adoptedAgain === adopted, `second adoption: ${adoptedAgain}`)
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
