/**
 * A scripted LLM adapter for repeatable proofs.
 *
 * `LlmAdapter` (packages/llm/llm/src/index.ts) only requires `stream`, so a
 * test can register a provider route whose responses are scripted per call:
 * one text answer, or one batch of tool calls, consumed in order. Every
 * request the harness assembled is recorded, which is how the prompt and
 * tool-declaration proofs read what the model actually saw.
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolCallId as brandToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One scripted model response. */
export interface ScriptedResponse {
  /** Assistant text for this response. */
  readonly text?: string
  /** Tool calls the model asks for, in order. */
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[]
}

/** The script a proof fills in, and what the scripted model saw. */
export class ScriptedLlm {
  /** Responses consumed in order; the last one repeats when the list runs out. */
  responses: ScriptedResponse[] = []
  /**
   * When set, every stream waits for this promise before its first chunk, so a
   * proof can observe a window that has opened but has not answered yet.
   */
  gate: Promise<void> | undefined
  /** Every assembled request, in call order. */
  readonly seen: GenerateOptions[] = []
}

/** The scripted provider route's id. */
export const SCRIPTED_PROVIDER = 'mock-scripted'

/** The scripted provider route's model id. */
export const SCRIPTED_MODEL = 'mock-model'

/** One scripted response as the chunk stream the harness consumes. */
function* chunksOf(response: ScriptedResponse): Generator<StreamChunk> {
  const calls = response.toolCalls ?? []
  if (calls.length === 0) {
    const text = response.text ?? ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (text.length > 0) yield { type: 'text-delta', index: 0, text }
    const block: ContentBlock = { type: 'text', text }
    yield { type: 'block-end', index: 0, block }
  } else {
    let index = 0
    for (const [position, call] of calls.entries()) {
      index = position
      const id = brandToolCallId(`scripted-call-${position + 1}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      const block: ContentBlock = { type: 'tool-call', id, name: call.name, arguments: args }
      yield { type: 'block-end', index, block }
    }
    void index
  }
  const usage: TokenUsage = { inputTokens: 10, outputTokens: 5 }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: calls.length === 0 ? 'stop' : 'tool-calls' } }
}

/** The scripted adapter: one response per stream call, in script order. */
export class ScriptedAdapter extends LlmAdapter {
  private readonly script: ScriptedLlm

  constructor(script: ScriptedLlm) {
    super()
    this.script = script
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Scripted mock model' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: SCRIPTED_MODEL, name: `${provider}/${SCRIPTED_MODEL}` }]
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.script
    script.seen.push(options)
    const response = script.responses.length > 1
      ? (script.responses.shift() as ScriptedResponse)
      : (script.responses[0] ?? {})
    return {
      async *[Symbol.asyncIterator]() {
        // The gate is awaited before the first chunk, so a proof can watch a
        // window that has opened and has not answered yet.
        if (script.gate !== undefined) await script.gate
        for (const chunk of chunksOf(response)) {
          options.signal?.throwIfAborted()
          yield chunk
        }
      },
    }
  }
}

/** Register the scripted route on one booted context. */
export function installScriptedLlm(ctx: Context, script: ScriptedLlm): () => void {
  return ctx.llm.registerAdapter([SCRIPTED_PROVIDER], new ScriptedAdapter(script))
}

/** The model selection that routes to the scripted model. */
export const SCRIPTED_SELECTION = { provider: SCRIPTED_PROVIDER, model: SCRIPTED_MODEL } as const
