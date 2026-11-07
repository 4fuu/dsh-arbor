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
 *  - the workspace root is the session's cwd: the window's own directory is
 *    created under it, and the `<workspace>` prompt section names it.
 *
 * Run: pnpm proof:storage
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
    check('the window retention is set, because the root is the user project',
      settings.workspaces?.retentionMs === 7 * 24 * 60 * 60 * 1000,
      `retentionMs: ${settings.workspaces?.retentionMs}`)

    // ---- the workspace root is the session's cwd.
    const firstWindow = windowOf(ctx, firstSession)!
    const mount = await host.host.services.ensureWorkspace(firstWindow)
    check('the window directory is under the session cwd',
      mount !== undefined && mount.path === join(first, `ws${firstWindow.slice(1)}`),
      `window ${firstWindow} works in ${mount?.path ?? 'nothing'}; the session's cwd is ${first}`)
    const secondWindow = windowOf(ctx, secondSession)!
    const secondMount = await host.host.services.ensureWorkspace(secondWindow)
    check('a second session window works in its own cwd',
      secondMount?.path === join(second, `ws${secondWindow.slice(1)}`),
      `window ${secondWindow} works in ${secondMount?.path ?? 'nothing'}; the session's cwd is ${second}`)
    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(firstSession) ?? ''
    check('the <workspace> section names the session cwd',
      /<workspace>[\s\S]*keep\/<名称>/.test(prompt) && prompt.includes(first),
      `the section names ${first}: ${prompt.includes(first)}`)
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
