/**
 * Proof 27: the arbor preset's Windows tool set and the real context budget.
 *
 * Two failures from the Windows run are checked here:
 *
 *  1. The arbor preset declared `plugins: []`, so DSH's preset-level tools did
 *     not exist in an arbor session. The allowlist now mounts DSH's
 *     non-duplicative rows; this proof asserts the tool set written into the
 *     rendered `<tools>` section is exactly the set the model request declares
 *     (what it can call), that the kept DSH tools are there, that nothing on
 *     the deny side leaked in, and that the win32 composition (the shell names
 *     and the terminal backend split) is the one the preset declares.
 *  2. Every window used arbor's hardcoded 200k limit. The host now reads the
 *     selected model's real context window from `ctx.llm.resolveModelInfo` and
 *     derives the reserve from it; this proof checks a model with a 64k window
 *     gets 64k/1280 and that a route DSH cannot describe falls back to 200k/4k
 *     with `limitSource: 'default'` in the facts.
 *
 * Run: pnpm proof:windows-tools
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_MODEL,
  SCRIPTED_SELECTION,
  ScriptedAdapter,
  agentPresetsOf,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  finishProof,
  freshDshHome,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'
import { arborPresetPlugins, PRESET_PINNED_VERSION } from '../packages/arbor-preset/src/index.ts'
import { DSH_TOOLS_ARBOR_REPLACES } from '../packages/arbor-tools/src/index.ts'

const NAME = 'arbor-spike-proof-27'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))
const webFixtureOverlay = fileURLToPath(new URL('../patches/web-fixture.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** The names the `<tools>` section writes, one per line. */
function toolsInPrompt(prompt: string): string[] {
  const section = /<tools>([\s\S]*?)<\/tools>/.exec(prompt)?.[1] ?? ''
  return section
    .split('\n')
    .map(line => /^([a-z][a-z0-9_]*)：/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined)
    .sort()
}

/** The names the model request declares. */
function toolsInRequest(names: readonly string[]): string[] {
  return [...new Set(names)].sort()
}

/** The live window arbor opened for one session. */
async function liveWindowOf(ctx: Parameters<typeof arborHostOf>[0], sessionId: SessionId): Promise<{ ref: string; limit: number; reserve: number } | undefined> {
  const host = arborHostOf(ctx)
  const ref = await host.windowFor(sessionId)
  if (ref === undefined) return undefined
  const record = host.host.live().find(one => one.window === ref)
  return record === undefined ? undefined : { ref, limit: record.usage.limit, reserve: record.usage.reserve }
}

async function main(): Promise<void> {
  scriptedLlm.contextWindow = 64_000
  scriptedLlm.responses = [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }]
  await freshDshHome('arbor-spike-27')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay, webFixtureOverlay],
  })
  try {
    const presets = agentPresetsOf(ctx)
    // A second route on the same script that reports no context capacity; it
    // is the fallback case without clearing the first route's cached budget.
    ctx.llm.registerAdapter(['mock-plain'], new ScriptedAdapter(scriptedLlm, null))

    // ---- one arbor session on the model with a real 64k window.
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    await presets.select(agent, 'arbor')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // ---- what the window rendered, and what the model could call.
    const prompt = (ctx.get('arborDriver') as {
      systemPromptOf(id: SessionId): string | undefined
    }).systemPromptOf(sessionId) ?? ''
    const request = scriptedLlm.seen.find(seen => seen.tools !== undefined)
    const callable = toolsInRequest((request?.tools ?? []).map(tool => String(tool.name)))
    const written = toolsInPrompt(prompt)
    check('the prompt names every callable tool and nothing else',
      written.join(',') === callable.join(','),
      `prompt: ${written.join(', ')} | callable: ${callable.join(', ')}`)
    check('the prompt tool list has no duplicate name',
      new Set(written).size === written.length,
      `${written.length} lines, ${new Set(written).size} names`)

    // ---- the tools the arbor preset now mounts.
    for (const name of ['web_search', 'web_fetch', 'ask_user_question', 'present', 'todo_write', 'plugin_manager']) {
      check(`${name} reaches the window`, callable.includes(name), `tools: ${callable.join(', ')}`)
    }
    // Plan mode's tool is admitted by its condition, not by the catalog: a
    // normal-mode step must not see it, and the plan-mode case below must.
    check('exit_plan_mode is not admitted outside plan mode', !callable.includes('exit_plan_mode'),
      `tools: ${callable.join(', ')}`)
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const shellLine = (prompt.match(/<tools>([\s\S]*?)<\/tools>/) ?? [])[1]
      ?.split('\n').find(line => line.startsWith(`${shell}：`)) ?? ''
    check(`the ${shell} tool is arbor's own, not DSH's`, shellLine.includes('工作区'), shellLine)
    const readLine = (prompt.match(/<tools>([\s\S]*?)<\/tools>/) ?? [])[1]
      ?.split('\n').find(line => line.startsWith('read：')) ?? ''
    check('the read tool is arbor\'s own, not DSH\'s read', readLine.includes('工作区'), readLine)
    const harness = /<harness>([\s\S]*?)<\/harness>/.exec(prompt)?.[1] ?? ''
    check('web_search usage text is in <harness>', harness.includes('web_search results are external'),
      `harness length: ${harness.length}`)

    // ---- nothing arbor replaces leaked in. The names bash/read/write/edit
    // overlap arbor's own tools by design; the checks above that the prompt and
    // callable sets agree, and that their lines are arbor's, cover the overlap.
    const families = ['job_start', 'job_output', 'job_kill', 'job_list', 'glob', 'grep', 'schedule',
      'subagent', 'subagent_fork', 'create_goal', 'get_goal', 'update_goal', 'send_message',
      'list_agents', 'interrupt_agent', 'ralph', 'workflow', 'session_search', 'session_trace',
      'structured_output', 'run_code', 'working_directory', 'skill']
    const leaked = families.filter(name => callable.includes(name))
    check('no denied tool family is callable', leaked.length === 0, `leaked: ${leaked.join(', ') || 'none'}`)

    // ---- the shell the installed core gives this host: PowerShell on Windows,
    // the POSIX shell elsewhere.
    if (process.platform === 'win32') {
      check('Windows exposes the PowerShell tools',
        ['pwsh', 'pwsh_output', 'pwsh_stop'].every(name => callable.includes(name)),
        `tools: ${callable.join(', ')}`)
      check('a Windows window exposes no bash tool',
        !callable.some(name => name.startsWith('bash')),
        `tools: ${callable.join(', ')}`)
    } else {
      check('Linux exposes the POSIX shell tools',
        ['bash', 'bash_output', 'bash_stop'].every(name => callable.includes(name)),
        `tools: ${callable.join(', ')}`)
      check('a Linux window exposes no pwsh tool',
        !callable.some(name => name.startsWith('pwsh')),
        `tools: ${callable.join(', ')}`)
    }

    // ---- plan mode: the preset row's exit_plan_mode and plan:policy.
    const planMode = agent.ctx.get('planMode') as { set(agent: Agent, active: boolean): string } | undefined
    const switched = planMode?.set(agent, true)
    check('plan mode was switched on', switched === 'committed' || switched === 'queued', `set returned ${String(switched)}`)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan it' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const planRequest = scriptedLlm.seen.findLast(seen => seen.tools !== undefined)
    const planCallable = toolsInRequest((planRequest?.tools ?? []).map(tool => String(tool.name)))
    check('plan mode admits exit_plan_mode to the model', planCallable.includes('exit_plan_mode'),
      `tools: ${planCallable.join(', ')}`)
    // ---- the real context window and reserve.
    const window = await liveWindowOf(ctx, sessionId)
    check('the window records the model context window',
      window?.limit === 64_000 && window?.reserve === 1_280,
      `window: ${JSON.stringify(window)}`)
    const facts = await ctx.arborFacts.factsFor(sessionId)
    const windowFact = facts.windows.find(one => one.ref === window?.ref)
    check('the window facts say the limit came from the model',
      windowFact?.limit === 64_000 && windowFact.limitSource === 'model',
      `fact: ${JSON.stringify(windowFact)}`)
    check('the settings facts carry the model budget',
      facts.settings.window?.contextTokens === 64_000 && facts.settings.window.contextTokensSource === 'model',
      `settings.window: ${JSON.stringify(facts.settings.window)}`)

    // ---- a route DSH cannot describe falls back to arbor's default.
    const fallbackId = brandString<SessionId>(`session-${randomUUID()}`)
    const fallbackOptions: AgentOptions = { provider: 'mock-plain', model: SCRIPTED_MODEL }
    const { agent: fallback } = await ctx.agents.create({
      sessionId: fallbackId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions: fallbackOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    await presets.select(fallback, 'arbor')
    fallback.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await fallback.whenIdle()
    const fallbackWindow = await liveWindowOf(ctx, fallbackId)
    check('a model DSH cannot describe uses arbor\'s default budget',
      fallbackWindow?.limit === 200_000 && fallbackWindow?.reserve === 4_000,
      `window: ${JSON.stringify(fallbackWindow)}`)
    const fallbackFacts = await ctx.arborFacts.factsFor(fallbackId)
    const fallbackFact = fallbackFacts.windows.find(one => one.ref === fallbackWindow?.ref)
    check('the fallback window says the limit is arbor\'s default',
      fallbackFact?.limitSource === 'default',
      `fact: ${JSON.stringify(fallbackFact)}`)

    // ---- the win32 composition is explicit and keeps DSH's platform split.
    check('the preset rows are pinned to this DSH', PRESET_PINNED_VERSION === '0.2.2-rc.1', PRESET_PINNED_VERSION)
    const linux = arborPresetPlugins('linux')
    const windows = arborPresetPlugins('win32')
    const idsOf = (rows: typeof linux): string[] => rows.map(row => String(row.id ?? '')).filter(id => id !== '')
    check('the win32 composition mounts the same rows', idsOf(linux).join(',') === idsOf(windows).join(','),
      `linux: ${idsOf(linux).join(', ')} | win32: ${idsOf(windows).join(', ')}`)
    const terminalOf = (rows: typeof linux): { bash: boolean; pwsh: boolean } => {
      const group = rows.find(row => row.id === 'terminals')
      const children = (group?.config ?? []) as readonly { id?: string; disabled?: boolean }[]
      const of = (id: string): boolean => children.some(child => child.id === id && child.disabled === false)
      return { bash: of('terminal-bash'), pwsh: of('terminal-pwsh') }
    }
    check('the Linux terminal backend is the bash one',
      terminalOf(linux).bash && !terminalOf(linux).pwsh, JSON.stringify(terminalOf(linux)))
    check('the Windows terminal backend is the pwsh one',
      !terminalOf(windows).bash && terminalOf(windows).pwsh, JSON.stringify(terminalOf(windows)))
    const moduleNames = windows.map(row => String(row.name))
    check('the allowlist mounts no shell, file-write, job, schedule or delegation row',
      !moduleNames.some(name => /tool-(bash|pwsh|jobs|schedule|subagent|goal|workflow|session-query|skill|ralph)$/.test(name)),
      `rows: ${moduleNames.join(', ')}`)
    check('the deny list covers both DSH shell names',
      ['bash', 'pwsh'].every(name => DSH_TOOLS_ARBOR_REPLACES.includes(name)),
      `replaced: bash=${DSH_TOOLS_ARBOR_REPLACES.includes('bash')} pwsh=${DSH_TOOLS_ARBOR_REPLACES.includes('pwsh')}`)
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
finishProof('PROOF 27', failures)
