/**
 * The arbor agent preset.
 *
 * A DSH user picks a preset when a session is created; the picked preset is
 * recorded on the session's header and its log (`agent-preset/selected`), and
 * the routing registry (`@4fu/dsh-arbor-driver`) routes every session whose
 * header names `arbor` to the arbor driver. This row is what puts `arbor` in
 * the roster a deployment offers, the way `presets/standard.patch.yml` in
 * `@deepseek-ai/dsh-web-app` declares `standard`.
 *
 * The composition is empty on purpose. The rows that make arbor run — the
 * routing registry that replaces the base `agent` row, the one Arbor host and
 * the driver — are process-wide by design (one journal, one note store, one
 * board, one factory slot), so they come from the bundle patch rather than
 * from a preset's per-session mount, which a preset's isolate realms could not
 * publish to the registry anyway. What a preset adds later — the prompt and
 * tool bridges of the next stage, for instance — belongs here, and the row
 * keeps the child expressions of such a composition intact through
 * `EntryGroup`.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** The arbor preset's declaration. */
export const ARBOR_PRESET: PresetDefinition = {
  id: 'arbor',
  name: 'Arbor',
  description: 'Runs the session through arbor: one shared journal, one note store and one board, with the reply streamed back as an assistant message.',
  order: 50,
  plugins: [],
}

/** Plugin config: the declaration, with the arbor defaults under it. */
export interface Config {
  readonly id?: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins?: readonly unknown[]
}

/** Registers the arbor preset in the deployment's preset roster. */
export default class ArborPreset extends Service {
  /**
   * The preset registry is a web-profile service, so it is injected rather than
   * required: the row activates everywhere, and on a deployment with no roster
   * — headless, acp, sdk — it simply never registers instead of waiting for a
   * service that will not come. Such a deployment selects arbor through
   * `meta.agentPreset` instead, which the routing registry reads either way.
   */
  static inject: readonly string[] = []

  /** Preserve child expressions until their own plugins activate. */
  static readonly [EntryGroup.key] = true

  static Config: z<Config, Config> = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    order: z.number(),
    plugins: z.array(z.any()),
  }) as unknown as z<Config, Config>

  readonly config: Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'arborPreset')
    this.config = config
  }

  protected [Service.init](): void {
    this.ctx.inject(['agentPresets'], (child) => {
      child.effect(() => {
        const unregister = child.agentPresets.register(this.declaration())
        unregister.catch((error: unknown) => {
          child.logger.warn(`arbor preset registration failed: ${String(error)}`)
        })
        return async () => { await unregister.catch(() => {}) }
      }, 'arborPreset.register()')
    })
  }

  /** The declaration this row registers: the arbor defaults under the config. */
  private declaration(): PresetDefinition {
    return {
      ...ARBOR_PRESET,
      ...this.config,
      plugins: (this.config.plugins ?? ARBOR_PRESET.plugins) as PresetDefinition['plugins'],
    }
  }
}
