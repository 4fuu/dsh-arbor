/**
 * The routing agent registry for arbor.
 *
 * DSH allows exactly one AgentFactory per process: `AgentRegistry.setFactory`
 * throws `'an agent factory is already registered'` on a second call
 * (packages/core/agent/src/index.ts, setFactory ~L383-399), and AgentLoop
 * claims that single slot in its own `[Service.init]`
 * (packages/core/agent-loop/src/index.ts L336). A bundle patch also cannot
 * swap which package a row mounts — `applyPatches` treats a patch's `name` as
 * a check only (vendor/include/src/patch.ts) — so the base `agent` row is
 * disabled and this subclass is inserted in its place.
 *
 * The subclass keeps TWO factories:
 *
 *  - the official AgentLoop, captured when it registers itself through the
 *    overridden `setFactory` (never passed to the base class, so the base
 *    slot stays free and nothing throws); and
 *  - the arbor driver, registered through {@link useArborFactory}.
 *
 * `create` routes on `meta.agentPreset === 'arbor'`; `resume` asks the arbor
 * driver whether the persisted session is an arbor session and routes
 * accordingly. Both paths delegate exactly the way the base class does
 * (`getTraceable` + `Reflect.apply` through the caller-traced receiver), so
 * the embedded loop keeps creating its agents into this same registry
 * instance: ordinary DSH sessions keep working, including every consumer that
 * reads `ctx.agents` (session-controller routing, UI liveness, the subagent
 * tool).
 */

import { getTraceable, symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The agent-preset value that routes a session to arbor. */
export const ARBOR_PRESET = 'arbor'

/** An agent factory that can also say whether a persisted session is its own. */
export interface ArborRoutingFactory extends AgentFactory {
  /** Whether the persisted session with this id runs under the arbor driver. */
  ownsSession?(sessionId: SessionId): Promise<boolean>
}

/** Delegate to one factory exactly the way `AgentRegistry.create/resume` do. */
function delegate(
  ownerCtx: Context,
  factory: AgentFactory,
  method: 'createAgent' | 'resume',
  options: CreateAgentOptions | ResumeAgentOptions,
): Promise<AgentHandle> {
  const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
  const receiver = getTraceable(ownerCtx, target)
  return Reflect.apply(target[method], receiver, [ownerCtx, options]) as Promise<AgentHandle>
}

/** The agent registry with per-preset routing over an embedded AgentLoop. */
export class ArborAgentRegistry extends AgentRegistry {
  private embeddedFactory: AgentFactory | undefined
  private arborFactory: ArborRoutingFactory | undefined

  /**
   * Capture the official loop's self-registration instead of claiming the
   * base class's single factory slot. AgentLoop calls this from its
   * `[Service.init]`; the returned disposer clears the capture on unload.
   */
  setFactory(factory: AgentFactory): () => void {
    this.embeddedFactory = factory
    return () => {
      if (this.embeddedFactory === factory) this.embeddedFactory = undefined
    }
  }

  /** Register the arbor routing factory. Returns its disposer. */
  useArborFactory(factory: ArborRoutingFactory): () => void {
    this.arborFactory = factory
    return () => {
      if (this.arborFactory === factory) this.arborFactory = undefined
    }
  }

  /** The captured official AgentLoop, when one is mounted. */
  get embedded(): AgentFactory | undefined {
    return this.embeddedFactory
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    // Every session is created through the arbor driver while it is mounted: the
    // driver runs arbor sessions itself and keeps the embedded loop's handle for
    // the others, which is what lets a preset selection re-route a session that
    // has not started a turn (see ArborDriver's `agent-preset/selected` seam).
    // Without the driver every session keeps running on the embedded loop, which
    // is what a deployment that loads neither row gets.
    const arbor = this.arborFactory
    if (arbor !== undefined) return delegate(this.ctx, arbor, 'createAgent', options)
    return delegate(this.ctx, this.requireEmbedded(), 'createAgent', options)
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    // The driver decides per session: it owns the persisted session when the log
    // records arbor, and hands everything else to the embedded loop. Both paths
    // keep their handle, for the same reason `create` does.
    const arbor = this.arborFactory
    if (arbor !== undefined) return delegate(this.ctx, arbor, 'resume', options)
    return delegate(this.ctx, this.requireEmbedded(), 'resume', options)
  }

  private requireEmbedded(): AgentFactory {
    if (this.embeddedFactory === undefined) {
      throw new Error('no agent factory registered (load an agent-loop plugin)')
    }
    return this.embeddedFactory
  }
}

export default ArborAgentRegistry
