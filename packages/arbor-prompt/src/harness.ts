/**
 * The `<harness>` section: what dsh-arbor itself writes about running inside
 * DeepSeek Harness.
 *
 * Arbor's own sections (`<identity>`, `<agent>`, `<tools>`, `<modules>`,
 * `<env>`, `<workspace>`) carry the framework's logic. This section carries
 * DSH's: that the window runs inside DeepSeek Harness and the user only sees
 * what `send` writes, the approval policy, how to write
 * image and file links into `send` so DSH renders them, how `@path`
 * references arrive, plan mode's guidance while it is active, and the usage
 * text of the DSH tools that are actually exposed to arbor windows.
 *
 * It is not marked `outside`: it is framework prompt, written by this bridge,
 * not third-party data. Only the third-party material in `<dsh>` is data.
 *
 * Every fixed line is named by its key in {@link dshTextTable} rather than
 * written into the block, because arbor's renderer escapes a block's field
 * values and the `send` link syntax needs its angle brackets to survive. The
 * two kinds that carry text — a DSH tool's usage and the deployment's plan
 * guidance — are escaped, which is right: they are material from outside this
 * bridge.
 *
 * The section's `revision` covers every input the content depends on, so a
 * change to any of them reaches a running window as a `prompt_delta` carrying
 * only the changed lines, rather than a rebuilt prefix.
 */

import type { Block, BlockKindSpec } from '@4fu/arbor-interfaces'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { decideSection, type SectionDecision } from './sections.ts'
import { dshTextTable } from './text.ts'

/**
 * One fixed line of the `<harness>` section, named by its text-table key.
 *
 * The key is a field so one kind serves every line; the line itself comes from
 * the table, which the renderer writes verbatim rather than escaped.
 */
export const HARNESS_LINE_BLOCK: BlockKindSpec = {
  kind: 'harness_line',
  fields: [{ name: 'key', type: 'string', required: true }],
  lines: ['{key}'],
}

/** One DSH tool's usage text, carried through verbatim. */
export const HARNESS_TOOL_BLOCK: BlockKindSpec = {
  kind: 'harness_tool',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
  ],
  lines: ['dsh.harness.tool'],
}

/** One block of text configured from outside this bridge: plan mode's guidance. */
export const HARNESS_TEXT_BLOCK: BlockKindSpec = {
  kind: 'harness_text',
  fields: [{ name: 'text', type: 'string', required: true }],
}

/** Every block kind the `<harness>` section renders. */
export const HARNESS_BLOCKS: readonly BlockKindSpec[] = [
  HARNESS_LINE_BLOCK,
  HARNESS_TOOL_BLOCK,
  HARNESS_TEXT_BLOCK,
]

/** The dynamic inputs the `<harness>` section renders, and its revision covers. */
export interface HarnessState {
  /** The approval policy in effect, or `undefined` when DSH reports none. */
  readonly approval: 'ask' | 'never' | undefined
  /** Whether plan mode is active for the session whose turn is rendering. */
  readonly planActive: boolean
  /** The DSH tool names actually exposed to arbor windows, sorted. */
  readonly exposedTools: readonly string[]
}

/** One rendered `<harness>` section, with what it decided. */
export interface HarnessRender {
  /** The section's blocks. */
  readonly blocks: readonly Block[]
  /** The official tool sections this render carried through, by name. */
  readonly carried: readonly string[]
}

/** One fixed line, named by its text-table key. */
function line(key: string): Block {
  return { kind: 'harness_line', fields: { key } }
}

/** The section texts of one assembly, by name. */
function textsOf(assembly: PromptAssembly): Map<string, string> {
  const texts = new Map<string, string>()
  for (const section of assembly.sections) texts.set(section.name, section.text)
  for (const context of assembly.contexts) texts.set(context.name, context.text)
  return texts
}

/**
 * Whether one kept tool section governs at least one exposed tool.
 *
 * `tool:<x>` governs the tool named `<x>`. `tool:pty` is DSH's terminal
 * family, whose tools are named `terminal_*`. A prefixed section
 * (`browser-use:`, `computer-use:`, `terminal:`) governs the tools that share
 * its prefix.
 */
function governs(sectionName: string, exposed: readonly string[]): boolean {
  if (sectionName === 'tool:pty') return exposed.some(name => name.startsWith('terminal_') || name === 'pty')
  if (sectionName.endsWith(':')) return exposed.some(name => name.startsWith(sectionName))
  return exposed.includes(sectionName.slice('tool:'.length))
}

/**
 * Render the `<harness>` section's blocks from DSH's own assembly.
 *
 * A DSH section the table drops contributes nothing. A section the table
 * keeps is either rewritten in this bridge's words (the approval policy, the
 * `send` link wording, the `@path` wording) or carried through
 * verbatim (a DSH tool's usage text, and the deployment's plan-mode guidance).
 */
export function renderHarness(assembly: PromptAssembly, state: HarnessState): HarnessRender {
  const texts = textsOf(assembly)
  const blocks: Block[] = [line('dsh.harness.lead')]
  const carried: string[] = []

  // Approval policy: dsh-arbor's own wording for DSH's two policies. The
  // policy itself is read from the state, so a mid-window switch moves the
  // section's revision and reaches the window as a delta.
  if (state.approval === 'never') {
    blocks.push(line('dsh.harness.approval.never'))
  } else if (state.approval === 'ask') {
    blocks.push(line('dsh.harness.approval.ask'))
  }

  // How to write links into `send`, so DSH renders them. DSH's own section
  // speaks of the final response; only `send` reaches the user here. The
  // target line comes first, because a send to a target nobody owns is an
  // effect that never reaches anybody.
  blocks.push(line('dsh.harness.send.target'))
  blocks.push(line('dsh.harness.send.image'))
  blocks.push(line('dsh.harness.send.file'))
  if (state.exposedTools.includes('present')) blocks.push(line('dsh.harness.send.present'))
  blocks.push(line('dsh.harness.reference'))

  // Plan mode: the deployment's own guidance, verbatim, behind a lead line of
  // this bridge's, and only while plan mode is active.
  const plan = state.planActive ? texts.get('plan:policy') ?? '' : ''
  if (plan !== '') {
    blocks.push(line('dsh.harness.plan.lead'))
    blocks.push({ kind: 'harness_text', fields: { text: plan } })
  }

  // The DSH tools that are actually exposed: their usage text, verbatim, in
  // DSH's own English. A tool that is not exposed writes nothing.
  const exposed = [...state.exposedTools].sort()
  for (const [name, text] of texts) {
    if (text === '') continue
    if (decideSection(name) !== 'harness') continue
    if (!name.startsWith('tool:') && !name.endsWith(':')) continue
    if (!governs(name, exposed)) continue
    carried.push(name)
    blocks.push({
      kind: 'harness_tool',
      fields: { name: name.slice('tool:'.length), text },
    })
  }

  return { blocks, carried }
}

/**
 * Detect a DSH section declared `complete: true`.
 *
 * A complete section replaces every other section in DSH's own assembly, so
 * the only observable is the collapse: `SystemPrompt`'s constructor always
 * registers `harness:identity` and the two persona sections, so an assembly
 * that holds a persona section and no `harness:identity` is one a complete
 * section took over. For an arbor session that must not be honoured — it would
 * replace arbor's whole prompt — so the bridge records a warning and carries
 * on with the persona as ordinary text.
 */
export function detectCompleteSection(assembly: PromptAssembly): string | undefined {
  const names = assembly.sections.map(section => section.name)
  if (names.length !== 1) return undefined
  const [only] = names
  if (only === undefined || !only.startsWith('deployment:persona-')) return undefined
  return only
}

/** The decision each consumed official section was rendered under, for diagnostics. */
export function consumedDecisions(names: readonly string[]): readonly { name: string; decision: SectionDecision }[] {
  return names.map(name => ({ name, decision: decideSection(name) }))
}
