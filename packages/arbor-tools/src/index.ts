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
 * B1 note: every registered DSH tool is exposed as-is, host-level and
 * session-free. Dropping the official same-name tools that arbor's own
 * file/bash tools replace, restricting the rest, and the faithful JSON Schema
 * mapping are the next stage's work.
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
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

/**
 * The live turn's abort signal, which a running session agent exposes so a
 * tool call is aborted with the turn that asked for it. The arbor session
 * agent implements it; any other agent simply does not, and the call then runs
 * on a signal of its own, the way a standalone call does.
 */
export interface LiveTurnSignal {
  currentSignal(): AbortSignal | undefined
}

/** Inputs for {@link dshExternalTools}. */
export interface DshExternalToolsOptions {
  /** DSH's tool registry. */
  readonly tools: ToolsService
  /**
   * DSH's agent registry. One backend serves every session, so the agent a
   * call runs as is read per call: the initiating agent of the turn executing
   * it, which is the session whose window asked for the call.
   */
  readonly agents: AgentRegistry
}

/**
 * Every registered DSH tool as arbor external tools.
 *
 * The specs are host-level and session-free: the same declarations reach the
 * model whichever session's window is running, and each call executes as the
 * session whose turn is running it. With no initiating agent — a call outside
 * any turn — DSH's own pipeline degrades the execution to a deny, which is the
 * correct fail-closed answer.
 *
 * The execution carries no log position, so DSH's pipeline does not write the
 * `tool/call` + `tool/result` pair: the driver's bridge writes one pair for
 * every call the window runs, arbor's own tools included, because the session
 * log is the history the next model request is derived from.
 *
 * The parameter round-trip (DSH JSON Schema → arbor ParameterSpec → DSH JSON
 * Schema) is lossy for exotic schemas; the faithful mapping and the
 * official-tool replacement are the next stage's work.
 */
export function dshExternalTools(options: DshExternalToolsOptions): readonly ExternalTool[] {
  const { tools, agents } = options
  return tools.schemas().map(schema => ({
    name: schema.name,
    description: schema.description,
    parameters: parametersOf(schema),
    execute: async (request: ToolCall): Promise<ToolResult> => {
      const agent = agents.currentInitiator()
      const live = agent as (Agent & Partial<LiveTurnSignal>) | undefined
      const signal = live?.currentSignal?.() ?? new AbortController().signal
      const call: ToolCallBlock = {
        type: 'tool-call',
        id: request.callId as ToolCallBlock['id'],
        name: request.name,
        arguments: JSON.stringify(request.args),
      }
      const batch = await tools.execute({
        calls: [call],
        ...agent === undefined ? {} : { agent },
        signal,
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
