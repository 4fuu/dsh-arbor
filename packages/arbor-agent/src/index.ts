/**
 * `@4fu/dsh-arbor-agent` — the DSH plugin that runs arbor as the agent driver.
 *
 * The default export is the routing `AgentRegistry` subclass the patch row
 * mounts in place of the base `agent` row; `./driver` mounts the arbor driver
 * that owns one Arbor host per arbor session.
 */

export { ArborAgentRegistry, ARBOR_PRESET } from './registry.ts'
export type { ArborRoutingFactory } from './registry.ts'
export { ArborSessionAgent } from './session-agent.ts'
export type { ArborWindowBridge, ModelCallInput, ModelCallOutcome } from './session-agent.ts'
export { ArborInbox, inboxProjectionDefinition } from './inbox.ts'
export { ArborStreamAttempt } from './assistant-stream.ts'

export { default } from './registry.ts'
