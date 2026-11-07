/**
 * Tool bridge: DSH's registered tools enter arbor as external tools and run
 * through `ctx.tools.execute`.
 *
 * `AgentBackend.externalTools()` (arbor-interfaces/agent.d.ts) is the seam the
 * plan names: the host registers what it is handed, and from there a DSH tool
 * is a direct tool like any other — declared to the model under its own name
 * and called through the same hooks, journaling, scrub and result cut as
 * arbor's own. Execution lands back in DSH: `ctx.tools.execute` with the
 * user session's agent, which is what routes a tool call that needs approval
 * through DSH's approval path (`packages/core/tools/src/pipeline.ts`
 * serviceAsk → `packages/interaction/user-approval`), and appends the durable
 * `tool/call` + `tool/result` pair to the user session's log.
 *
 * B0 note: every registered DSH tool is exposed as-is. B1 drops the official
 * same-name tools that arbor's own file/bash tools replace and restricts the
 * rest, per the plan.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type { DirectToolSpec, ExternalTool, ParameterSpec, ToolCall, ToolResult } from '@4fu/arbor-interfaces'

/** JSON Schema types DSH tool parameters use, mapped to arbor parameter types. */
function parameterTypeOf(schema: Record<string, unknown>): ParameterSpec['type'] {
  const type = schema['type']
  switch (type) {
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

/** One DSH tool schema as an arbor direct-tool parameter map. */
export function parametersOf(schema: {
  readonly parameters?: Record<string, unknown>
}): Record<string, ParameterSpec> {
  const root = (schema.parameters ?? {}) as Record<string, unknown>
  const properties = (root['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(root['required']) ? root['required'] as string[] : [])
  const parameters: Record<string, ParameterSpec> = {}
  for (const [name, property] of Object.entries(properties)) {
    parameters[name] = {
      type: parameterTypeOf(property),
      description: typeof property['description'] === 'string' ? property['description'] : '',
      ...required.has(name) ? { required: true } : {},
    }
  }
  return parameters
}

/** One arbor direct-tool spec back to a DSH tool schema for the model request. */
export function schemaOf(spec: DirectToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, parameter] of Object.entries(spec.parameters)) {
    properties[name] = {
      type: parameter.type === 'number' ? 'number'
        : parameter.type === 'boolean' ? 'boolean'
        : parameter.type === 'array' ? 'array'
        : parameter.type === 'object' ? 'object'
        : 'string',
      description: parameter.description,
    }
    if (parameter.required === true) required.push(name)
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties, ...required.length > 0 ? { required } : {} },
  }
}

/** Inputs for {@link dshExternalTools}. */
export interface DshExternalToolsOptions {
  /** DSH's tool registry. */
  readonly tools: ToolsService
  /** The user session's agent: scope, log position, and approval routing. */
  readonly agent: Agent
  /** The live turn/step position tool events are logged at. */
  readonly position: () => { turn: number; step: number } | undefined
  /** The live turn's abort signal. */
  readonly signal: () => AbortSignal | undefined
}

/**
 * Every registered DSH tool as arbor external tools.
 *
 * The parameter round-trip (DSH JSON Schema → arbor ParameterSpec → DSH JSON
 * Schema) is lossy for exotic schemas; B1 maps the official tool set
 * faithfully and replaces the same-name official tools with arbor's own.
 */
export function dshExternalTools(options: DshExternalToolsOptions): readonly ExternalTool[] {
  const { tools, agent } = options
  return tools.schemas().map(schema => ({
    name: schema.name,
    description: schema.description,
    parameters: parametersOf(schema),
    execute: async (request: ToolCall): Promise<ToolResult> => {
      const position = options.position()
      const signal = options.signal()
      const call: ToolCallBlock = {
        type: 'tool-call',
        id: request.callId as ToolCallBlock['id'],
        name: request.name,
        arguments: JSON.stringify(request.args),
      }
      const batch = await tools.execute({
        calls: [call],
        agent,
        signal: signal ?? new AbortController().signal,
        ...position === undefined ? {} : { log: position },
      })
      const settled = batch.results.find(result => result.callId === request.callId) ?? batch.results[0]
      const result = settled?.result
      if (result === undefined) {
        return { callId: request.callId, ok: false, content: `tool "${request.name}" produced no result`, tool: request.name }
      }
      const text = result.content.map(block => ('text' in block ? block.text : '')).join('')
      return {
        callId: request.callId,
        ok: !result.isError,
        content: text,
        tool: request.name,
        ...result.isError ? { error: { rule: 'tool.failed', message: text } } : {},
      }
    },
  }))
}
