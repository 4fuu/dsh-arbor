/**
 * Prompt bridge: DSH's prompt sections reach an arbor window as one `<dsh>`
 * outside block.
 *
 * DSH assembles its system prompt from registered `PromptSection`s
 * (`@deepseek-ai/dsh-system-prompt`): official sections from `@deepseek-ai/*`
 * packages (`harness:identity`, `tool:bash`, `context:file-reference`, …) and
 * third-party sections from plugins. The plan drops the official ones by name
 * prefix — arbor's own prompt carries the framework's structure instead — and
 * puts the third-party ones into a `<dsh>` block that arbor renders as data,
 * so a conflict resolves to arbor's rules
 * (`@4fu/arbor-interfaces/plugin.d.ts` PromptSection.outside).
 *
 * The bridge registers an arbor `Plugin` whose prompt section is that `<dsh>`
 * block. Its `revision()` follows DSH's own `system-prompt/change`
 * notifications, so a live window is re-rendered only when a DSH section
 * actually changed, and arbor delivers the changed lines as a `prompt_delta`
 * at the next tool-call boundary.
 *
 * B1 keeps this bridge exactly as the spike proved it. The drop-by-prefix rule
 * is withdrawn for B2: the system prompt is then to carry both arbor's logic
 * and DSH's own mechanisms, with a per-section decision table pinned to the
 * DSH version and a `<harness>` section dsh-arbor writes itself. The seam B2
 * replaces is the one this module already has — {@link isOfficialSection}, the
 * two lists it reads, and {@link renderDshSections}, which is where the
 * per-section decisions and the extra sections are rendered. Nothing else in
 * this package needs to change for that, and nothing here is extended in B1.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { BlockKindSpec, Plugin, PromptSection } from '@4fu/arbor-interfaces'
import { dataBlock } from '@4fu/arbor-prompt'
import { createHash } from 'node:crypto'

/**
 * Official DSH prompt-section name prefixes, dropped from the `<dsh>` block.
 *
 * Derived from every non-test `systemPrompt.section({ name: ... })`
 * registration in deepseek-harness at dsh-v0.2.2-rc.1, grouped by the
 * taxonomy packages/core/system-prompt/src/index.ts SECTION_ORDERS defines:
 * `harness:`, `deployment:`, `tool:`, `context:`, `plan:`, `team:`,
 * `subagent:`, `approval:`, `mcp:`, `jobs:`, `schedule:`, `workflow:`,
 * `session:`, `ui:`, `ptc:`, `browser-use:`, `computer-use:`, `terminal:`,
 * `ralph:`.
 */
export const DSH_OFFICIAL_SECTION_PREFIXES: readonly string[] = [
  'harness:',
  'deployment:',
  'tool:',
  'context:',
  'plan:',
  'team:',
  'subagent:',
  'approval:',
  'mcp:',
  'jobs:',
  'schedule:',
  'workflow:',
  'session:',
  'ui:',
  'ptc:',
  'browser-use:',
  'computer-use:',
  'terminal:',
  'ralph:',
]

/**
 * Official section names that carry no prefix of their own: the exact
 * registrations in deepseek-harness at dsh-v0.2.2-rc.1 whose names sit
 * outside the taxonomy (`packages/mcp/mcp-resources/src/index.ts`).
 */
export const DSH_OFFICIAL_SECTION_NAMES: readonly string[] = [
  'mcp-resource-servers',
]

/** Whether a DSH prompt section is official, and therefore dropped. */
export function isOfficialSection(name: string): boolean {
  return DSH_OFFICIAL_SECTION_NAMES.includes(name)
    || DSH_OFFICIAL_SECTION_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** The part of DSH's system-prompt service the bridge uses. */
export interface DshSystemPrompt {
  assemble(context: {
    agent?: Agent
    scope?: Agent
    signal?: AbortSignal
  }): Promise<PromptAssembly>
}

/** Inputs for {@link renderDshSections}. */
export interface DshPromptSource {
  /** DSH's system-prompt registry. */
  readonly systemPrompt: DshSystemPrompt
  /**
   * The agent whose scope the assembly runs in. Omitted by the process-wide
   * host: arbor's prompt epochs are shared by every window of one epoch, so the
   * `<dsh>` block renders the sections the composition registers at its root.
   * A section registered inside one session's own scope — by its preset or its
   * setup — is not carried yet.
   */
  readonly agent?: Agent
  /** The current turn's signal, when the render belongs to a turn. */
  readonly signal?: AbortSignal
}

/**
 * Assemble DSH's prompt for one agent, drop the official sections, and render
 * what is left (variables interpolated, exactly as `renderPrompt` does).
 * @returns the third-party section text, or `''` when nothing is left.
 */
export async function renderDshSections(source: DshPromptSource): Promise<string> {
  const assembly: PromptAssembly = await source.systemPrompt.assemble({
    ...source.agent === undefined ? {} : { agent: source.agent, scope: source.agent },
    ...source.signal === undefined ? {} : { signal: source.signal },
  })
  const thirdParty: PromptAssembly = {
    ...assembly,
    sections: assembly.sections.filter(section => !isOfficialSection(section.name)),
  }
  return renderPrompt(thirdParty)
}

/** The `<dsh>` block kind the section renders: one data field, no tag of its own. */
export const DSH_DATA_BLOCK: BlockKindSpec = {
  kind: 'data',
  fields: [{ name: 'content', type: 'string', required: true }],
}

/** Inputs for {@link dshPromptPlugin}. */
export interface DshPromptPluginOptions extends DshPromptSource {
  /**
   * DSH's `system-prompt/change` counter, raised by the caller whenever a
   * prompt provider changes. The section's revision follows it, so arbor
   * re-renders the block only when a DSH section actually changed.
   */
  readonly changeCounter: () => number
}

/**
 * The arbor plugin that contributes DSH's third-party prompt sections as the
 * `<dsh>` outside block.
 */
export function dshPromptPlugin(options: DshPromptPluginOptions): Plugin & {
  readonly promptSection: PromptSection
} {
  return {
    name: 'dsh',
    promptSection: {
      tag: 'dsh',
      blocks: [DSH_DATA_BLOCK],
      content: async () => [dataBlock(await renderDshSections(options))],
      revision: async () => String(options.changeCounter()),
      outside: true,
    },
  }
}

/** A stable digest of one rendered section, for tests and diagnostics. */
export function sectionDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
