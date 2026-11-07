/**
 * The scripted-model plugin row: registers the scripted provider route and
 * the spike's test tool once the LLM and tool services are active.
 *
 * The row exists because `bootArborProfile`'s `prepare` hook runs before any
 * composed entry activates — service-availability-driven activation is what
 * makes a row the right place to register a provider or a tool.
 *
 * The proof fills {@link scriptedLlm}.responses before boot; the adapter
 * holds the same object, so the script can also be changed between turns.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  ScriptedAdapter,
  ScriptedLlm,
} from './scripted-llm.ts'

/** The shared script every proof fills in. */
export const scriptedLlm = new ScriptedLlm()

/** Every run of the spike's test tool, in order. */
export const spikeToolRuns: { args: unknown }[] = []

/** Every approval ask the spike's asking tool produced, in order. */
export const spikeApprovalAsks: { name: string; reason: string }[] = []

/** Registers the scripted provider route and the spike_echo test tool. */
export class ScriptedLlmService extends Service {
  static inject = ['llm', 'tools']

  constructor(ctx: Context) {
    super(ctx, 'arborScriptedLlm')
  }

  protected [Service.init](): void {
    this.ctx.llm.registerAdapter([SCRIPTED_PROVIDER], new ScriptedAdapter(scriptedLlm))
    // A tool whose calls need approval: the pre-execute waterfall turns the
    // call into an ask, which is what routes it to DSH's approval path.
    this.ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== 'spike_ask') return next()
      spikeApprovalAsks.push({ name: exec.name, reason: 'the spike asks for approval' })
      return Promise.resolve({ kind: 'ask' as const, reason: 'the spike asks for approval' })
    })
    this.ctx.tools.register({
      name: 'spike_ask',
      description: 'Run a guarded action that needs approval. Test-only tool for the B0 spike.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: 'the action to run' } },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', properties: { ran: { type: 'string' } }, required: ['ran'] },
        render: (_args, value) => [{ type: 'text', text: `ran: ${(value as { ran: string }).ran}` }],
      },
      execute: async (args: unknown) => {
        spikeToolRuns.push({ args })
        return { ran: (args as { action: string }).action }
      },
    })
    this.ctx.tools.register({
      name: 'spike_echo',
      description: 'Echo the text back. Test-only tool for the B0 spike.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'the text to echo' } },
        required: ['text'],
      },
      output: {
        schema: { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'] },
        render: (_args, value) => [{ type: 'text', text: `echo: ${(value as { echo: string }).echo}` }],
      },
      execute: async (args: unknown) => {
        spikeToolRuns.push({ args })
        return { echo: (args as { text: string }).text }
      },
    })
  }
}

export default ScriptedLlmService
