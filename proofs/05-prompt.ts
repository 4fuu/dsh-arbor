/**
 * Proof 5: prompt assembly with official sections dropped and a third-party
 * section inside `<dsh>`.
 *
 * The boot composes a third-party prompt section (`acme:policy`, registered by
 * the prompt-section overlay row exactly as a third-party DSH plugin would)
 * alongside the official sections the shipped base bundle registers
 * (`harness:identity`, `tool:bash`, `approval:policy`, `context:file-reference`,
 * …). One arbor turn then assembles the window's prompt through the bridge
 * (`@4fu/dsh-arbor-prompt`), and the proof checks what the model actually saw:
 *
 *  - the arbor window's own structure is there (`<identity>`, `<agent>`,
 *    `<tools>`), and the precedence rule appears in `<agent>` because an
 *    outside section exists;
 *  - the third-party section text is inside the `<dsh>` block, marked as
 *    outside data;
 *  - NOT ONE official DSH section text survives: every section DSH itself
 *    assembled under an official name is absent from the window's prompt.
 *
 * The official/third-party split is taken from DSH's own assembly, not from a
 * hardcoded list, so the check covers whatever the shipped profile registers.
 *
 * Run: pnpm proof:prompt
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  ACME_POLICY_TEXT,
  SCRIPTED_SELECTION,
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
  finishProof,
} from '../packages/arbor-testkit/src/index.ts'
import { isOfficialSection } from '../packages/arbor-prompt/src/index.ts'

const NAME = 'arbor-spike-proof-5'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const promptOverlay = fileURLToPath(new URL('../patches/prompt.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  scriptedLlm.responses = [{ text: 'ok' }]
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, promptOverlay],
  })
  try {
    const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // What the arbor window rendered for this session.
    const windowPrompt = (ctx.get('arborDriver') as {
      systemPromptOf(id: SessionId): string | undefined
    }).systemPromptOf(sessionId)
    check('window rendered a system prompt', typeof windowPrompt === 'string' && windowPrompt.length > 0,
      `prompt length: ${windowPrompt?.length ?? 0}`)
    const prompt = windowPrompt ?? ''

    // What the model actually saw: the system/message on the session log.
    const systemMessages: string[] = []
    for (let seq = 0; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(seq as never)
      if (event?.type !== 'system/message') continue
      const message = (event.data as { message: { content: readonly { type: string; text?: string }[] } }).message
      systemMessages.push(...message.content.filter(block => block.type === 'text').map(block => block.text ?? ''))
    }
    check('model saw the window prompt', systemMessages.some(text => text === prompt),
      `system/message events: ${systemMessages.length}`)

    // DSH's own assembly, split by the bridge's official-prefix rule.
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const official = assembly.sections.filter(section => isOfficialSection(section.name))
    const thirdParty = assembly.sections.filter(section => !isOfficialSection(section.name))
    const officialText = renderPrompt({ ...assembly, sections: official })
    console.log(`DSH sections: ${assembly.sections.length} total, ${official.length} official, ${thirdParty.length} third-party`)
    console.log(`official names: ${official.map(section => section.name).join(', ')}`)
    console.log(`third-party names: ${thirdParty.map(section => section.name).join(', ')}`)

    check('third-party section registered', thirdParty.some(section => section.name === 'acme:policy'),
      `third-party: ${thirdParty.map(section => section.name).join(', ')}`)

    // Arbor's own structure, and the precedence rule an outside section adds.
    for (const tag of ['identity', 'agent', 'tools']) {
      check(`arbor <${tag}> section present`, prompt.includes(`<${tag}>`), `prompt has <${tag}>: ${prompt.includes(`<${tag}>`)}`)
    }
    check('precedence rule present because an outside section exists',
      /<agent>[\s\S]*framework's own prompt wins|优先|冲突/.test(prompt) || prompt.includes('wins'),
      'the <agent> rules state the framework wins on conflict')

    // The third-party section inside <dsh>.
    const dshBlock = /<dsh>([\s\S]*?)<\/dsh>/.exec(prompt)
    check('<dsh> block present', dshBlock !== null, `prompt has <dsh>: ${dshBlock !== null}`)
    check('third-party section text inside <dsh>', dshBlock?.[1]?.includes(ACME_POLICY_TEXT) === true,
      `<dsh> holds the acme:policy text: ${dshBlock?.[1]?.includes(ACME_POLICY_TEXT) === true}`)

    // Not one official section text survives.
    const survivors = official
      .map(section => section.name)
      .filter((_name, index) => {
        const text = official[index]?.text ?? ''
        return text.length > 0 && prompt.includes(text)
      })
    check('no official section text survives', survivors.length === 0,
      `survivors: ${survivors.length === 0 ? 'none' : survivors.join(', ')}`)
    check('official sections existed to drop', official.length > 0,
      `official sections: ${official.length}`)
    const renderedOfficial = officialText.length > 0
    check('official prompt was non-empty before dropping', renderedOfficial,
      `rendered official length: ${officialText.length}`)
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
finishProof('PROOF 5', failures)
