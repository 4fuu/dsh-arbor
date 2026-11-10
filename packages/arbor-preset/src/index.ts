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
 * The composition is the allowlist in `plugins.ts`: DSH's preset-level tools
 * that arbor does not replace, pinned to the DSH version. The rows that make
 * arbor run — the routing registry that replaces the base `agent` row, the one
 * Arbor host and the driver — are process-wide by design (one journal, one note
 * store, one board, one factory slot), so they come from the bundle patch rather
 * than from a preset's per-session mount, which a preset's isolate realms could
 * not publish to the registry anyway. A row belongs here when a session needs
 * it, like the web, presentation, question, plan-mode and Cordis tools; a row
 * that duplicates an arbor direct tool does not.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { arborPresetPlugins } from './plugins.ts'

export { PRESET_PINNED_VERSION, arborPresetPlugins } from './plugins.ts'

/** The arbor preset's declaration. */
export const ARBOR_PRESET: PresetDefinition = {
  id: 'arbor',
  name: 'Arbor',
  description: 'Runs the session through arbor: one shared journal, one note store and one board, with the reply streamed back as an assistant message.',
  order: 50,
  plugins: arborPresetPlugins(),
}

/** Plugin config: the declaration, with the arbor defaults under it. */
export interface Config {
  readonly id?: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Extra or replacement rows; empty keeps the default allowlist. */
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
    // A config that names no rows keeps the default allowlist. Schemastery
    // materializes the declared array as `[]` when the row carries no
    // `plugins`, and an empty list is the one value that would silently restore
    // the old "no DSH tools" composition.
    const configured = this.config.plugins
    return {
      ...ARBOR_PRESET,
      ...this.config,
      plugins: configured !== undefined && configured.length > 0
        ? configured as PresetDefinition['plugins']
        : ARBOR_PRESET.plugins,
    }
  }
}
