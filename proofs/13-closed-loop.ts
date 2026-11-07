/**
 * Proof 13: the closed loop — everything the prompt says about the workspace
 * and the environment, end to end, across a restart.
 *
 * The four things a window is told, each checked where it is acted on:
 *
 *  - the workspace is the session's cwd, so a `write` lands in the project and
 *    a `bash` command runs there;
 *  - a DSH skill is readable from `/env`, so `read` of the path the `<env>`
 *    section names returns the skill's own body;
 *  - the mount survives a DSH restart: the session resumes onto the window the
 *    host continued, the workspace is still the cwd, and the skill is still
 *    mounted and readable;
 *  - with `ARBOR_PROOF_LIVE=1`, the same loop runs against the real DeepSeek
 *    model: it reads the DSH skill's SKILL.md through arbor's own `read` tool
 *    and answers from it.
 *
 * Run: pnpm proof:loop                  (scripted model, deterministic)
 *      ARBOR_PROOF_LIVE=1 pnpm proof:loop   (real DeepSeek model)
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
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
  PROBE_SKILL,
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  proofLive,
  scriptedLlm,
  useDshFixtures,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'

/** One scripted model response. */
type Response = { toolCalls?: readonly { name: string; args: Record<string, unknown> }[]; text?: string }

const NAME = 'arbor-spike-proof-13'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const dshEnvOverlay = fileURLToPath(new URL('../patches/dsh-env.patch.yml', import.meta.url))

/** The skill's path as the `<env>` section names it. */
const SKILL_PATH = `/env/skills/${PROBE_SKILL.name}/SKILL.md`

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** Every tool-result text one session's log carries, in order. */
function resultTexts(agent: Agent): string[] {
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type !== 'tool/result') continue
    const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
    texts.push(...(message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
  }
  return texts
}

/** Every assistant text one session's log carries, in order. */
function assistantTexts(agent: Agent): string[] {
  const texts: string[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event?.type !== 'assistant/message') continue
    const message = (event.data as { message?: { content?: readonly ContentBlock[] } }).message
    texts.push(...(message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
  }
  return texts
}

/** The model selection one boot drives with. */
function selectionOf(ctx: Context): AgentOptions {
  return proofLive ? { ...ctx.agentDefaultModel.currentSelection() } : { ...SCRIPTED_SELECTION }
}

async function main(): Promise<void> {
  useDshFixtures()
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const project = await mkdtemp(join(tmpdir(), 'arbor-loop-'))
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const overlays = proofLive
    ? [arborPatch, arborOverlay, dshEnvOverlay]
    : [arborPatch, arborOverlay, scriptedOverlay, dshEnvOverlay]

  // ---- the first process: one turn that writes and reads the DSH skill.
  let ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: overlays })
  let agent: Agent
  try {
    scriptedLlm.responses = [{ text: 'warmed up' }]
    const created = await ctx.agents.create({
      sessionId,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: selectionOf(ctx),
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    agent = created.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    scriptedLlm.responses = [
      { toolCalls: [{ name: 'write', args: { path: 'before.txt', text: 'written before the restart' } }] },
      { toolCalls: [{ name: 'read', args: { path: SKILL_PATH } }] },
      { text: 'the note is written and the skill is read' },
    ] as Response[]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write a note, then read the probe skill' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = resultTexts(agent)
    check('a write lands in the session cwd before the restart',
      existsSync(join(project, 'before.txt'))
        && await readFile(join(project, 'before.txt'), 'utf8') === 'written before the restart',
      `before.txt: ${existsSync(join(project, 'before.txt')) ? await readFile(join(project, 'before.txt'), 'utf8') : 'absent'}`)
    check('read of the DSH skill returns its own body before the restart',
      results.some(text => text.includes('This is a DSH skill the proof registers')),
      `tool results: ${JSON.stringify(results.map(text => text.slice(0, 100)))}`)
  } finally {
    await ctx.fiber.dispose()
  }

  // ---- the restart: the second process on the same DSH home.
  ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: overlays })
  try {
    const host = arborHostOf(ctx)
    const continued = await host.windowFor(sessionId)
    check('the restart continued the session window', continued !== undefined,
      `the host continued: ${continued ?? 'nothing'}`)
    const resumed = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: selectionOf(ctx),
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    agent = resumed.agent
    scriptedLlm.responses = [{ text: 'warmed up' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up again' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const driver = ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
    const prompt = driver.systemPromptOf(sessionId) ?? ''
    check('the <workspace> section still names the session cwd after the restart',
      prompt.includes(project), `the section names ${project}: ${prompt.includes(project)}`)
    check('the <env> section still lists the DSH skill after the restart',
      prompt.includes(PROBE_SKILL.name) && prompt.includes(SKILL_PATH),
      `the <env> section names ${PROBE_SKILL.name}: ${prompt.includes(PROBE_SKILL.name)}`)

    const task = proofLive
      ? `Read ${SKILL_PATH} with your read tool, then answer in one sentence what that skill tells you to do.`
      : 'write another note, read the skill again, and say where you are'
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'write', args: { path: 'after.txt', text: 'written after the restart' } }] },
      { toolCalls: [{ name: 'read', args: { path: SKILL_PATH } }] },
      { toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
      { text: 'everything survived the restart' },
    ] as Response[]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = resultTexts(agent)
    check('a write lands in the session cwd after the restart',
      existsSync(join(project, 'after.txt'))
        && await readFile(join(project, 'after.txt'), 'utf8') === 'written after the restart',
      `after.txt: ${existsSync(join(project, 'after.txt')) ? await readFile(join(project, 'after.txt'), 'utf8') : 'absent'}`)
    check('the DSH skill is still mounted and readable after the restart',
      results.some(text => text.includes('This is a DSH skill the proof registers')),
      `tool results: ${JSON.stringify(results.map(text => text.slice(0, 100)))}`)
    check('a command still runs in the session cwd after the restart',
      results.some(text => text.includes(project)),
      `tool results: ${JSON.stringify(results.map(text => text.slice(0, 100)))}`)
    if (proofLive) {
      const answers = assistantTexts(agent)
      check('the live model answered from the DSH skill it read',
        answers.some(text => /echo|probe|read/i.test(text)),
        `assistant texts: ${JSON.stringify(answers.map(text => text.slice(0, 200)))}`)
    }
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
finishProof('PROOF 13', failures)
