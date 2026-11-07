/**
 * `@4fu/dsh-arbor-driver` — the DSH plugin that runs arbor as the agent driver.
 *
 * The default export is the routing `AgentRegistry` subclass the patch row
 * mounts in place of the base `agent` row; `./driver` mounts the arbor driver
 * that runs arbor-preset sessions on the process's one Arbor host.
 */

export { ArborAgentRegistry, ARBOR_PRESET } from './registry.ts'
export type { ArborRoutingFactory } from './registry.ts'
export { ArborSessionAgent } from './session-agent.ts'
export type { ArborWindowBridge, ModelCallInput, ModelCallOutcome } from './session-agent.ts'
export { ArborInbox, inboxProjectionDefinition } from './inbox.ts'
export { ArborStreamAttempt } from './assistant-stream.ts'
export { ArborDriver } from './driver.ts'
export type { Config as DriverConfig, SessionArborLike } from './driver.ts'
export { windowToolCalls, relayToolCalls } from './relay.ts'
export type { ArborToolCall } from './relay.ts'

export { default } from './registry.ts'
