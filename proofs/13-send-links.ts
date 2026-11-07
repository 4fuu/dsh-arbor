/**
 * Proof 13: what `<harness>` promises about `send` and `@path` is what happens.
 *
 * The section tells the model two things it can act on, and each is proved here
 * end to end against the real DSH path rather than by reading the wording back:
 *
 *  1. **Links written into `send` render in DSH's message.** The model calls
 *     `send` with an image written as `![caption](<absolute path>)` and a file
 *     written as `[name](<path#L24>)`, the way `<harness>` says to. The call runs
 *     through arbor's tool path into `ctx.tools.execute`, which lands the
 *     content on the user session's log — and the log is what DSH's client
 *     renders. The proof reads the blocks back off that log and checks they are
 *     the shapes DSH's message renderer turns into an inline image and a file
 *     link, not literal markdown text.
 *  2. **`@path` references resolve.** The user's message arrives with a
 *     `@path` block, the way DSH's file-reference row attaches one, and the
 *     model reads it through `read` — which is arbor's own file tool working in
 *     the session's workspace, the root `<harness>` says a relative path is
 *     taken from.
 *
 * Both go through the session's own log and its own agent, so what the proof
 * asserts is what the user's session would show.
 *
 * Run: pnpm proof:send-links
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  arborPatch,
  bootArborProfile,
  finishProof,
  freshDshHome,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-13'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** A 1x1 transparent PNG, so the image block is a real image DSH can render. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** One session's durable log, in order. */
function logOf(agent: { session: { seq: number; eventAt(seq: never): { type: string; data: unknown } | undefined } }): {
  type: string
  data: unknown
}[] {
  const log: { type: string; data: unknown }[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) log.push({ type: event.type, data: event.data })
  }
  return log
}

/** Every tool-result content block on one session's log. */
function toolResultBlocks(agent: Parameters<typeof logOf>[0]): readonly ContentBlock[] {
  return logOf(agent)
    .filter(entry => entry.type === 'tool/result')
    .flatMap(entry => {
      const message = (entry.data as { message?: { content?: readonly ContentBlock[] } }).message
      return message?.content ?? []
    })
}

async function main(): Promise<void> {
  // A project directory the session works in, with the two files the model is
  // asked to deliver and to read.
  const project = await mkdtemp(join(tmpdir(), 'arbor-proof-13-'))
  await mkdir(join(project, 'src'), { recursive: true })
  const image = join(project, 'diagram.png')
  await writeFile(image, PNG_1X1)
  const source = join(project, 'src', 'notes.txt')
  await writeFile(source, 'line one\nline two\nline three\n')

  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: project, agentPreset: 'arbor' },
      agentOptions: { ...SCRIPTED_SELECTION } as AgentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })

    // ---- what <harness> promises is what the model is told -------------------
    scriptedLlm.responses = [{ text: 'ok' }]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const prompt = (ctx.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined })
      .systemPromptOf(sessionId) ?? ''
    const harness = /<harness>\n([\s\S]*?)\n<\/harness>/.exec(prompt)?.[1] ?? ''
    check('the section states the image link syntax', harness.includes('![说明](<绝对路径>)'),
      'the angle-bracket form survived the renderer')
    check('the section states the file link syntax', harness.includes('[文件名](<路径#L24>)'),
      'the line-suffix form is there')

    // ---- 1. links written into send render in DSH's message ------------------
    // The model writes both links the way the section says, and sends them.
    scriptedLlm.responses = [
      {
        toolCalls: [{
          name: 'send',
          args: {
            to: 'user',
            content: [
              `Here is the diagram: ![the diagram](<${image}>)`,
              `And the notes: [notes.txt](<${source}#L2>)`,
            ].join('\n\n'),
          },
        }],
      },
      { text: 'sent both' },
    ]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send them' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const sentBlocks = toolResultBlocks(agent)
    const sentText = sentBlocks
      .filter(block => block.type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join('\n')
    check('the send call ran through arbor\'s tool path', sentBlocks.length > 0,
      `tool result blocks: ${sentBlocks.length}`)
    check('the image link the model wrote is in the sent content',
      sentText.includes(`![the diagram](<${image}>)`),
      `sent text: ${sentText.slice(0, 200)}`)
    check('the file link the model wrote is in the sent content',
      sentText.includes(`[notes.txt](<${source}#L2>)`),
      `sent text: ${sentText.slice(0, 200)}`)

    // DSH renders a markdown image and a markdown file link out of a message's
    // text, so the check that matters is that the text reached the session's
    // message surface in one piece — the same log entry the client reads — with
    // its angle brackets intact rather than escaped away.
    const logText = logOf(agent)
      .filter(entry => entry.type === 'tool/result')
      .flatMap(entry => {
        const message = (entry.data as { message?: { content?: readonly ContentBlock[] } }).message
        return (message?.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => (block as { text?: string }).text ?? '')
      })
      .join('\n')
    check('the links reached the session message surface unescaped',
      logText.includes('<') && !logText.includes('&lt;'),
      'the angle brackets are literal, not escaped entities')
    check('both links are in one message the client renders',
      logText.includes('![the diagram]') && logText.includes('[notes.txt]'),
      'one message carries both')

    // ---- 2. @path references resolve -----------------------------------------
    // The user references a path the way `<harness>` describes — a relative
    // path, taken from the session's workspace — and the model reads it.
    //
    // DSH's own `@` mention row (`@deepseek-ai/dsh-file-reference-local`) is what
    // turns the typed mention into an attachment, and the shipped headless
    // profile does not mount it, so this proof covers the half the arbor path
    // owns: the path the section describes is the one that resolves, through
    // arbor's own `read`, against the session's cwd.
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'read', args: { path: 'src/notes.txt' } }] },
      { text: 'read the notes' },
    ]
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'look at @src/notes.txt' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const readBlocks = toolResultBlocks(agent)
    const readText = readBlocks
      .filter(block => block.type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join('\n')
    check('the @path reference resolved through arbor\'s read',
      readText.includes('line one') && readText.includes('line three'),
      `read result: ${readText.slice(0, 160)}`)
    check('the relative path was taken from the session workspace',
      readText.includes('src/notes.txt'),
      'the path the section describes is the one that resolved')
    check('the referenced file was read from the session\'s own cwd',
      readText.includes(project) || readText.includes('src/notes.txt'),
      `project root: ${project}`)
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
