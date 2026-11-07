/**
 * Tool bridge: DSH's registered tools enter arbor as external tools and run
 * through `ctx.tools.execute`.
 *
 * `AgentBackend.externalTools()` (arbor-interfaces/agent.d.ts) is the seam the
 * plan names: the host registers what it is handed, and from there a DSH tool
 * is a direct tool like any other — declared to the model under its own name
 * and called through the same hooks, journaling, scrub and result cut as
 * arbor's own. Execution lands back in DSH: `ctx.tools.execute` with the user
 * session's agent, which is what routes a tool call that needs approval
 * through DSH's approval path (`packages/core/tools/src/pipeline.ts`
 * serviceAsk → `packages/interaction/user-approval`), and appends the durable
 * `tool/call` + `tool/result` pair to the user session's log.
 *
 * Two things make that seam faithful rather than lossy:
 *
 *  - **The schema is carried verbatim.** A DSH tool declares its parameters as
 *    JSON Schema; arbor's `ExternalTool.schema` is exactly that, so `enum`,
 *    `items`, `oneOf`, `additionalProperties` and a nested object's own
 *    properties all reach the model instead of being flattened away.
 *  - **Every capability appears once.** {@link DSH_TOOLS_ARBOR_REPLACES} names
 *    the DSH tools whose capability arbor already has, so they are neither
 *    handed to the catalog nor offered by DSH's own pipeline: the driver
 *    installs the same list as a `tools.restrict` in each arbor session's
 *    scope, which is also what makes their `tool:*` prompt sections render
 *    empty.
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type { ExternalTool, JSONSchema, DirectToolSpec, ToolCall, ToolResult } from '@4fu/arbor-interfaces'

/**
 * The DSH tools arbor's own replaces, one capability each.
 *
 * - `bash`, `pwsh` — arbor's `bash`, `bash_output`, `bash_stop`.
 * - `read`, `write`, `edit`, `apply_patch` — arbor's file tools.
 * - `glob`, `grep` — arbor's `workspace` module.
 * - `job_start`, `job_output`, `job_kill`, `job_list` — arbor's
 *   `bash_output` / `bash_stop`.
 * - `subagent`, `subagent_fork` — arbor's windows, its broadcast and its
 *   window messages.
 * - `schedule`, `schedule_*` — arbor's own `schedule` module. DSH's scheduler
 *   opens another DSH session, which fights arbor's source model.
 * - `create_goal`, `get_goal`, `update_goal` — goals are closed for arbor
 *   sessions.
 * - `team_*`, `send_message`, `list_agents`, `interrupt_agent` — teams are
 *   closed for arbor sessions.
 * - `ralph` — closed for arbor sessions.
 * - `workflow` — closed for arbor sessions.
 * - `session_search`, `session_trace`, `session_event_search`,
 *   `session_event_read`, `session_event_trace` — history is arbor's journal.
 * - `structured_output` — only DSH's own subagents use it.
 * - `run_code` — arbor has its own `code_exec`; DSH's PTC executor is not used.
 *
 * The list is filtered against what the deployment actually registers before
 * it is used, because `tools.restrict` rejects an unknown name.
 */
export const DSH_TOOLS_ARBOR_REPLACES: readonly string[] = [
  // bash / pwsh
  'bash',
  'pwsh',
  // read / write / edit / apply_patch
  'read',
  'write',
  'edit',
  'apply_patch',
  // glob / grep
  'glob',
  'grep',
  // job_*
  'job_start',
  'job_output',
  'job_kill',
  'job_list',
  // subagent / subagent_fork
  'subagent',
  'subagent_fork',
  // schedule_*
  'schedule',
  'schedule_create',
  'schedule_edit',
  'schedule_list',
  'schedule_view',
  'schedule_delete',
  'schedule_execution_pending',
  // goal
  'create_goal',
  'get_goal',
  'update_goal',
  // team
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'send_message',
  'list_agents',
  'interrupt_agent',
  // ralph
  'ralph',
  // workflow
  'workflow',
  // session-query
  'session_search',
  'session_trace',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
  // structured output and PTC
  'structured_output',
  'run_code',
]

/**
 * The subset of {@link DSH_TOOLS_ARBOR_REPLACES} the deployment registers.
 *
 * Filtered, because `tools.restrict` throws on a name that is not a known
 * global tool, and a deployment mounts only part of DSH.
 */
export function replacedToolsRegistered(tools: ToolsService): readonly string[] {
  const registered = new Set(tools.schemas().map(schema => schema.name))
  return DSH_TOOLS_ARBOR_REPLACES.filter(name => registered.has(name))
}

/** One arbor direct-tool spec back to a DSH tool schema for the model request. */
export function schemaOf(spec: DirectToolSpec): Record<string, unknown> {
  // A tool declared from outside the core carries DSH's own JSON Schema
  // verbatim, and that is what the model reads. Arbor's own tools declare
  // none: their `parameters` are the declaration, and the shape is built here.
  if (spec.schema !== undefined) {
    return { name: spec.name, description: spec.description, parameters: spec.schema }
  }
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
 * Every registered DSH tool arbor does not already have, as arbor external
 * tools.
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
 */
export function dshExternalTools(options: DshExternalToolsOptions): readonly ExternalTool[] {
  const { tools, agents } = options
  const replaced = new Set(DSH_TOOLS_ARBOR_REPLACES)
  return tools.schemas()
    .filter(schema => !replaced.has(schema.name))
    .map(schema => ({
      name: schema.name,
      description: schema.description,
      // DSH's own JSON Schema, carried verbatim: what the model reads is what
      // DSH declared, not a summary of it.
      schema: schema.parameters as JSONSchema,
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
