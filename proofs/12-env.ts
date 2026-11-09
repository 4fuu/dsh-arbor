/**
 * Proof 12: `/env` inside DSH — DSH's skills and MCP servers, mounted read-only
 * beside arbor's own.
 *
 * The fixtures are real DSH pieces, not stubs: one runtime skill registered on
 * `ctx.skills` (`SkillRegistry.register`, `@deepseek-ai/dsh-skill`) and one real
 * `mcp-client` row connected to a stdio MCP server, so the tools DSH publishes
 * under `mcp__probe__echo` are the thing `/env` reads the server list off. The
 * overlay is `patches/dsh-env.patch.yml`, which only this proof loads.
 *
 * Assertions:
 *  - the DSH skill appears in `<env>` with its path, and `read` of that path
 *    returns the skill's own body — the model can read a DSH skill's SKILL.md;
 *  - the DSH MCP server appears in `<env>` with its tool named, and declares no
 *    functions: the tools stay DSH tools, so no arbor MCP module duplicates
 *    them, and `code_exec`'s catalog holds no module of that name;
 *  - arbor's own environment still works: its built-in skills are listed, the
 *    settings seed the deployment's identity, and the model's own `reload`
 *    installs a skill of its own;
 *  - the mount is read-only: a `write` under `/env` is refused, and a `reload`
 *    naming a DSH item is refused rather than replacing it.
 *
 * Run: pnpm proof:env
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  PROBE_SKILL,
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  useDshFixtures,
  finishProof,
  tempDir,
} from '../packages/arbor-testkit/src/index.ts'

/** One scripted model response. */
type Response = { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }

const NAME = 'arbor-spike-proof-12'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const dshEnvOverlay = fileURLToPath(new URL('../patches/dsh-env.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  useDshFixtures()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await tempDir('arbor-env-')
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, dshEnvOverlay],
  })
  try {
    const host = arborHostOf(ctx)

    // ---- DSH really has the fixture skill and the fixture MCP server.
    const skills = ctx.get('skills') as { list(options?: { cwd?: string }): Promise<readonly { name: string }[]> }
    const dshSkills = (await skills.list({ cwd: project })).map(one => one.name)
    check('DSH offers the fixture skill', dshSkills.includes(PROBE_SKILL.name),
      `DSH skills: ${JSON.stringify(dshSkills)}`)
    const mcpTools = ctx.tools.definitions().map(tool => tool.name).filter(name => name.startsWith('mcp__'))
    check('DSH publishes the fixture MCP tool', mcpTools.includes('mcp__probe__echo'),
      `DSH MCP tools: ${JSON.stringify(mcpTools)}`)

    // ---- one session, driven for one turn, so a window renders the prompt.
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    scriptedLlm.responses = [{ text: 'the environment is mounted' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'look at your environment' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(sessionId) ?? ''
    const env = /<env>[\s\S]*?<\/env>/.exec(prompt)?.[0] ?? ''

    check('the <env> section lists the DSH skill with its path',
      env.includes(PROBE_SKILL.name) && env.includes(`/env/skills/${PROBE_SKILL.name}/SKILL.md`),
      `the <env> section: ${env.slice(0, 400)}`)
    check('the <env> section carries the DSH skill\'s own description',
      env.includes(PROBE_SKILL.description),
      'the description is DSH\'s, carried verbatim')
    check('the <env> section lists the DSH MCP server with its tool named',
      env.includes('probe') && env.includes('mcp__probe__echo'),
      `the <env> section: ${env.slice(0, 600)}`)
    check('the <env> section still lists arbor\'s own built-in skills',
      env.includes('arbor-skill') && env.includes('arbor-settings'),
      `the <env> section names the built-ins`)

    // ---- the mounted skill's file is readable, and it is DSH's body.
    const environment = (host.host as unknown as { options: { environment: { directory: string } } }).options.environment
    const mounted = join(environment.directory, 'skills', PROBE_SKILL.name, 'SKILL.md')
    check('the mounted SKILL.md exists on disk', existsSync(mounted), `mounted at: ${mounted}`)
    const mountedText = existsSync(mounted) ? await (await import('node:fs/promises')).readFile(mounted, 'utf8') : ''
    check('the mounted SKILL.md carries DSH\'s body',
      mountedText.includes('This is a DSH skill the proof registers'),
      `the mounted body: ${JSON.stringify(mountedText.slice(0, 120))}`)

    // ---- the model reads the skill's SKILL.md through arbor's own read tool.
    const reading = brandString<SessionId>(`session-${randomUUID()}`)
    const second = await ctx.agents.create({
      sessionId: reading,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'read', args: { path: `/env/skills/${PROBE_SKILL.name}/SKILL.md` } }] },
      { text: 'I read the DSH skill' },
    ]
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the probe skill' }], source: { kind: 'user' } }))
    await second.agent.whenIdle()
    const readResults: string[] = []
    for (let seq = 0; seq < second.agent.session.seq; seq++) {
      const event = second.agent.session.eventAt(seq as never)
      if (event?.type !== 'tool/result') continue
      const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
      readResults.push(...(message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    }
    check('read of the mounted SKILL.md returns DSH\'s body',
      readResults.some(text => text.includes('This is a DSH skill the proof registers')),
      `tool results: ${JSON.stringify(readResults.map(text => text.slice(0, 120)))}`)

    // ---- a write under /env is refused: the mount is read-only.
    const writing = brandString<SessionId>(`session-${randomUUID()}`)
    const third = await ctx.agents.create({
      sessionId: writing,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'write', args: { path: `/env/skills/${PROBE_SKILL.name}/SKILL.md`, text: 'overwritten' } }] },
      { text: 'the write was refused' },
    ]
    third.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'overwrite the skill' }], source: { kind: 'user' } }))
    await third.agent.whenIdle()
    const writeResults: string[] = []
    for (let seq = 0; seq < third.agent.session.seq; seq++) {
      const event = third.agent.session.eventAt(seq as never)
      if (event?.type !== 'tool/result') continue
      const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
      writeResults.push(...(message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    }
    check('a write under /env is refused',
      writeResults.some(text => text.includes('只读')),
      `tool results: ${JSON.stringify(writeResults.map(text => text.slice(0, 160)))}`)
    check('the mounted SKILL.md is unchanged',
      (await (await import('node:fs/promises')).readFile(mounted, 'utf8')).includes('This is a DSH skill the proof registers'),
      'the file still carries DSH\'s body')

    // ---- the model's own reload still works, and a DSH item is refused.
    // The session-title provider asks the model once per session, on the first
    // prompt, and the scripted model answers it from the same script — so the
    // session is warmed up with one turn of its own before the script that
    // matters is filled in.
    const own = join(project, 'own-skill')
    await mkdir(own, { recursive: true })
    // A skill's SKILL.md opens with a level-1 heading and one line that says
    // what it is for; the environment validates that on install
    // (`DirectoryEnvironment.checkSkill`).
    await writeFile(join(own, 'SKILL.md'), '# own-skill\n\nA skill the model installed itself.\n\nMy own skill.\n', 'utf8')
    const reloading = brandString<SessionId>(`session-${randomUUID()}`)
    const fourth = await ctx.agents.create({
      sessionId: reloading,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: { ...SCRIPTED_SELECTION },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    scriptedLlm.responses = [{ text: 'warmed up' }]
    fourth.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await fourth.agent.whenIdle()
    scriptedLlm.responses = [
      // `reload` refuses a draft in a window that has no workspace of its own
      // (`env.workspace`), so the window touches a file first, exactly as the
      // refusal tells the model to.
      { toolCalls: [{ name: 'write', args: { path: 'scratch.txt', text: 'the window has a workspace' } }] },
      { toolCalls: [{ name: 'reload', args: { install: [{ kind: 'skill', path: 'own-skill' }] } }] },
      { toolCalls: [{ name: 'reload', args: { remove: [PROBE_SKILL.name] } }] },
      { text: 'the reloads are done' },
    ]
    fourth.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'install your own skill, then remove the DSH one' }], source: { kind: 'user' } }))
    await fourth.agent.whenIdle()
    const reloadResults: string[] = []
    for (let seq = 0; seq < fourth.agent.session.seq; seq++) {
      const event = fourth.agent.session.eventAt(seq as never)
      if (event?.type !== 'tool/result') continue
      const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
      reloadResults.push(...(message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    }
    check('the model\'s own install works',
      reloadResults.some(text => text.includes('own-skill')),
      `tool results: ${JSON.stringify(reloadResults.map(text => text.slice(0, 120)))}`)
    check('removing a DSH item is refused',
      reloadResults.some(text => text.includes('DSH 挂进来的') && text.includes('只读')),
      `tool results: ${JSON.stringify(reloadResults.map(text => text.slice(0, 160)))}`)
    const after = (await (await import('node:fs/promises')).readdir(join(environment.directory, 'skills'))).sort()
    check('the DSH skill survived the refused removal', after.includes(PROBE_SKILL.name),
      `skills on disk: ${JSON.stringify(after)}`)
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
finishProof('PROOF 12', failures)
