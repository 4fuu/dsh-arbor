/**
 * Proof 6: common DSH plugins keep working with the routing registry.
 *
 * The arbor overlay replaces the `agent` row and adds the arbor driver; every
 * other row is exactly as shipped. This proof checks that the plugins a
 * ordinary DSH session relies on are unharmed on BOTH paths:
 *
 *  - their rows activate in the booted tree (tool-todo, tool-skill,
 *    plan-mode, agent-instructions, subagent, user-approval, tool-goal);
 *  - their prompt sections are still registered in DSH's assembly
 *    (`plan:policy`, `tool:goal`, `approval:policy`, `harness:identity`);
 *  - a common plugin's TOOL runs through the arbor bridge: the scripted model
 *    calls `todo_write` inside an arbor session, and the plugin's own
 *    `todo/write` event lands on the user session's log — which only happens
 *    because the call carries the user session's agent;
 *  - the same tool runs on an ordinary (embedded AgentLoop) session in the
 *    same process.
 *
 * Run: pnpm proof:plugins
 */

import { randomUUID } from 'node:crypto'
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
  arborPatch,
  bootArborProfile,
  freshDshHome,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-6'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

/** The rows this proof expects active, with the plugin each mounts. */
const COMMON_ROWS: readonly { id: string; plugin: string }[] = [
  { id: 'tool-todo', plugin: '@deepseek-ai/dsh-tool-todo' },
  { id: 'tool-skill', plugin: '@deepseek-ai/dsh-tool-skill' },
  { id: 'plan-mode', plugin: '@deepseek-ai/dsh-plan-mode' },
  { id: 'agent-instructions', plugin: '@deepseek-ai/dsh-agent-instructions' },
  { id: 'subagent', plugin: '@deepseek-ai/dsh-subagent' },
  { id: 'approval', plugin: '@deepseek-ai/dsh-user-approval' },
  { id: 'tool-goal', plugin: '@deepseek-ai/dsh-tool-goal' },
]

/** The prompt sections those plugins contribute. */
const COMMON_SECTIONS: readonly string[] = [
  'plan:policy',
  'tool:goal',
  'approval:policy',
  'harness:identity',
]

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  scriptedLlm.responses = [
    { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'prove the plugin path', status: 'in_progress' }] } }] },
    { text: 'todo list updated' },
  ]
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay],
  })
  try {
    const entries = [...ctx.loader.entries()]
    for (const row of COMMON_ROWS) {
      const entry = entries.find(candidate => candidate.options.id === row.id)
      check(`row ${row.id} active`, entry?.fiber !== undefined
        && entry.options.name === row.plugin,
        `${row.id} -> ${entry?.options.name} (active=${entry?.fiber !== undefined})`)
    }

    // The plugins' prompt sections, read from DSH's own assembly.
    const assembly = await ctx.systemPrompt.assemble()
    const names = [
      ...assembly.sections.map(section => section.name),
      ...assembly.contexts.map(context => context.name),
    ]
    for (const section of COMMON_SECTIONS) {
      check(`section ${section} registered`, names.includes(section),
        `registered: ${names.join(', ')}`)
    }

    // ---- arbor path: a common plugin's tool runs through the bridge.
    const arborSession = brandString<SessionId>(`session-${randomUUID()}`)
    const arbor = await createSession(ctx, arborSession, 'arbor')
    arbor.followup(createUserMessage({ content: [{ type: 'text', text: 'write a todo' }], source: { kind: 'user' } }))
    await arbor.whenIdle()

    const arborLog = logOf(arbor)
    const todoWrites = arborLog.filter(entry => entry.type === 'todo/write')
    check('todo_write ran through the arbor bridge', todoWrites.length === 1,
      `todo/write events on the user session: ${todoWrites.length}`)
    const todos = (todoWrites[0]?.data as { todos?: { content: string; status: string }[] } | undefined)?.todos ?? []
    check('the plugin wrote the scripted todo', todos.length === 1
      && todos[0]?.content === 'prove the plugin path' && todos[0]?.status === 'in_progress',
      `todos: ${JSON.stringify(todos)}`)
    const arborResults = arborLog.filter(entry => entry.type === 'tool/result')
    check('tool result logged for the arbor call', arborResults.length === 1,
      `tool/result events: ${arborResults.length}`)
    const arborAssistant = arborLog.filter(entry => entry.type === 'assistant/message')
      .flatMap(entry => {
        const message = (entry.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
        return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '')
      })
    check('model saw the plugin result', arborAssistant.some(text => text.includes('todo list updated')),
      `assistant texts: ${JSON.stringify(arborAssistant)}`)

    // ---- ordinary path: the same tool on an embedded-loop session.
    scriptedLlm.responses = [
      { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'prove the loop path', status: 'pending' }] } }] },
      { text: 'todo list updated on the loop path' },
    ]
    const ordinarySession = brandString<SessionId>(`session-${randomUUID()}`)
    const ordinary = await createSession(ctx, ordinarySession)
    ordinary.followup(createUserMessage({ content: [{ type: 'text', text: 'write a todo' }], source: { kind: 'user' } }))
    await ordinary.whenIdle()

    const ordinaryLog = logOf(ordinary)
    const ordinaryWrites = ordinaryLog.filter(entry => entry.type === 'todo/write')
    check('todo_write ran on the embedded loop too', ordinaryWrites.length === 1,
      `todo/write events on the ordinary session: ${ordinaryWrites.length}`)
    const ordinaryTodos = (ordinaryWrites[0]?.data as { todos?: { content: string }[] } | undefined)?.todos ?? []
    check('the plugin wrote the loop-path todo', ordinaryTodos.some(todo => todo.content === 'prove the loop path'),
      `todos: ${JSON.stringify(ordinaryTodos)}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Create one session agent, arbor-preset or ordinary. */
async function createSession(ctx: Context, sessionId: SessionId, preset?: string): Promise<Agent> {
  const agentOptions: AgentOptions = preset === undefined
    ? { ...ctx.agentDefaultModel.currentSelection(), ...SCRIPTED_SELECTION }
    : { ...SCRIPTED_SELECTION }
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd(), ...preset === undefined ? {} : { agentPreset: preset } },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  return agent
}

/** One session's durable log, in order. */
function logOf(agent: Agent): { type: string; data: unknown }[] {
  const log: { type: string; data: unknown }[] = []
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq as never)
    if (event !== undefined) log.push({ type: event.type, data: event.data })
  }
  return log
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
console.log(failures.length === 0 ? 'PROOF 6 OK' : `PROOF 6 FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
