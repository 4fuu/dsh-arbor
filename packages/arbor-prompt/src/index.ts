/**
 * Prompt bridge: DSH's prompt sections reach an arbor window as two sections —
 * a trusted `<harness>` dsh-arbor writes itself, and a `<dsh>` data block for
 * third-party material.
 *
 * DSH assembles its system prompt from registered `PromptSection`s and runtime
 * contexts (`@deepseek-ai/dsh-system-prompt`): official ones from
 * `@deepseek-ai/*` packages (`harness:identity`, `tool:bash`,
 * `approval:policy`, `context:file-reference`, …) and third-party ones from
 * plugins and MCP servers. B0 dropped every official section by name prefix;
 * that rule is withdrawn. Each official name is now decided by
 * {@link DSH_SECTION_DECISIONS}, pinned to one DSH version, and the decisions
 * are:
 *
 *  - what is still true on the arbor path is written into `<harness>`, in this
 *    bridge's own words where DSH's wording does not fit (DSH speaks of the
 *    final response; in arbor only `send` reaches the user) and verbatim where
 *    it does (a DSH tool's usage text, the deployment's plan-mode guidance);
 *  - the deployment's persona goes into arbor's `<identity>`;
 *  - third-party sections and MCP server instructions go into `<dsh>`, marked
 *    as data, so a conflict resolves to arbor's rules
 *    (`@4fu/arbor-interfaces/plugin.d.ts` PromptSection.outside);
 *  - what arbor's own replaces, or what does not exist here, is dropped.
 *
 * Both sections follow DSH's own `system-prompt/change` notifications and the
 * dynamic state the host reads, so arbor re-renders a section only when
 * something it writes actually moved and hands a live window the changed lines
 * as a `prompt_delta` — never a rebuilt prefix.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Block, Plugin } from '@4fu/arbor-interfaces'
import { dataBlock } from '@4fu/arbor-prompt'
import { createHash } from 'node:crypto'
import { DSH_DATA_BLOCK } from './blocks.ts'
import { HARNESS_BLOCKS, renderHarness, detectCompleteSection } from './harness.ts'
import type { HarnessState } from './harness.ts'
import { decideSection } from './sections.ts'
import { dshTextTable } from './text.ts'

export { DSH_DATA_BLOCK } from './blocks.ts'
export { DSH_PINNED_VERSION, DSH_SECTION_DECISIONS, DSH_SECTION_PREFIX_DECISIONS } from './sections.ts'
export type { SectionDecision } from './sections.ts'
export {
  DSH_OFFICIAL_SECTION_NAMES,
  DSH_OFFICIAL_SECTION_PREFIXES,
  decideSection,
  decisionFor,
  isOfficialSection,
  officialSectionNames,
} from './sections.ts'
export { DSH_TEXT_KEYS, dshTextTable } from './text.ts'
export {
  HARNESS_BLOCKS,
  HARNESS_LINE_BLOCK,
  HARNESS_TEXT_BLOCK,
  HARNESS_TOOL_BLOCK,
  consumedDecisions,
  detectCompleteSection,
  renderHarness,
} from './harness.ts'
export type { HarnessRender, HarnessState } from './harness.ts'

/** The part of DSH's system-prompt service the bridge uses. */
export interface DshSystemPrompt {
  assemble(context: {
    agent?: Agent
    scope?: Agent
    signal?: AbortSignal
  }): Promise<PromptAssembly>
}

/**
 * The DSH runtime contexts a window's snapshot carries.
 *
 * Every context the table decides `outside`, because a third party's runtime
 * context is dynamic per-session state rather than a prompt section, so the
 * snapshot is the only place it can reach the model.
 *
 * DSH's own `working-directory:current` is deliberately not carried: decisions
 * table revision 2 hands project management to arbor for an arbor session, the
 * project is arbor's own shared folder, and arbor's `<workspace>` section states
 * the paths. A second statement of the session's cwd would be a second
 * mechanism for one fact, and after the workspace moves off the session cwd it
 * would be a wrong one.
 *
 * The approval policy and plan mode are not here either: the `<harness>`
 * section writes them in dsh-arbor's own wording and reaches a running window
 * as a `prompt_delta` of the changed lines.
 */
export function snapshotContextNames(assembly: PromptAssembly): readonly string[] {
  return assembly.contexts
    .map(context => context.name)
    .filter(name => decideSection(name) === 'outside')
}

/** Inputs for {@link renderDshSections}. */
export interface DshPromptSource {
  /** DSH's system-prompt registry. */
  readonly systemPrompt: DshSystemPrompt
  /**
   * The agent whose scope the assembly runs in: one fixed agent, or a call that
   * answers with the session whose turn is rendering.
   *
   * The host passes the latter, because a section is rendered inside the turn
   * that opens the window and DSH's own `plan:policy` reads the agent to say
   * whether plan mode is active — an agent-less assembly renders it empty.
   * Arbor rebuilds an epoch whenever a plugin section's revision moves, and the
   * revision covers the rendering session's state, so two sessions of different
   * states never share one epoch.
   */
  readonly agent?: Agent | (() => Agent | undefined)
  /**
   * The signal the assembly runs under. The host passes a fresh one, because a
   * section is re-rendered by the host's own watch loop — after the turn that
   * opened the window has ended — and DSH's `working-directory` context provider
   * does filesystem I/O under this signal, which a finished turn's signal would
   * abort.
   */
  readonly signal?: AbortSignal
}

/** The agent one source names, resolved at the moment it is needed. */
function agentOf(source: DshPromptSource): Agent | undefined {
  const agent = source.agent
  return typeof agent === 'function' ? agent() : agent
}

/**
 * Assemble DSH's prompt for one agent, drop everything the table drops, and
 * render what is left (variables interpolated, exactly as `renderPrompt` does).
 * @returns the third-party section text, or `''` when nothing is left.
 */
export async function renderDshSections(source: DshPromptSource): Promise<string> {
  const agent = agentOf(source)
  const assembly: PromptAssembly = await source.systemPrompt.assemble({
    ...agent === undefined ? {} : { agent, scope: agent },
    ...source.signal === undefined ? {} : { signal: source.signal },
  })
  const thirdParty: PromptAssembly = {
    ...assembly,
    sections: assembly.sections.filter(section => decideSection(section.name) === 'outside'),
  }
  return renderPrompt(thirdParty)
}

/** The deployment's persona, read once when the host is built. */
export interface DeploymentPersona {
  /** The persona prefix text, or `''` when the deployment configures none. */
  readonly prefix: string
  /** The persona suffix text, or `''` when the deployment configures none. */
  readonly suffix: string
  /** The prompt variables the persona text carries, as DSH wrote them. */
  readonly variables: readonly string[]
  /** The warnings the read raised, one per line. */
  readonly warnings: readonly string[]
}

/**
 * Every prompt variable DSH's own providers register.
 *
 * `@deepseek-ai/dsh-agent-loop` registers exactly two, both read from the
 * agent that is rendering: `provider` and `model`. They are per-request values
 * in DSH — the loop re-resolves them on every request — and arbor's prefix is
 * frozen per epoch, so the bridge resolves them against the session whose turn
 * is rendering rather than capturing one value for the window's whole life.
 */
export const DSH_PROMPT_VARIABLES: readonly string[] = ['provider', 'model']

/** The values the rendering agent gives DSH's prompt variables. */
export interface PersonaVariables {
  readonly provider?: string
  readonly model?: string
}

/** Every `{{name}}` group one text carries. */
export function promptVariablesOf(text: string): readonly string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1] ?? '').filter(name => name !== '')
}

/**
 * Resolve DSH's prompt variables in one persona text.
 *
 * A variable the rendering agent gives no value for is dropped rather than left
 * in the prompt: a literal `{{model}}` reaching the model is worse than the
 * sentence reading oddly. `interpolate: false` sections are not touched.
 */
export function interpolatePersona(text: string, variables: PersonaVariables): string {
  return text.replace(/\{\{(\w+)\}\}/g, (group, name: string) => {
    const value = variables[name as keyof PersonaVariables]
    return value === undefined || value === '' ? '' : value
  }).replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Read the deployment's persona out of DSH's own assembly.
 *
 * The persona is the deployment's or the user's own configuration, so it
 * belongs in arbor's `<identity>` section rather than in a section of its own.
 * The section text is read raw — DSH interpolates it later, and interpolating
 * it here without an agent is what makes `{{model}}` unresolvable.
 *
 * A section declared `complete: true` is not honoured here — it would replace
 * arbor's whole prompt — so the collapse is reported as a warning and the
 * persona is still carried as ordinary text.
 */
export async function readDeploymentPersona(systemPrompt: DshSystemPrompt): Promise<DeploymentPersona> {
  const assembly = await systemPrompt.assemble({})
  const texts = new Map(assembly.sections.map(section => [section.name, section.text]))
  const prefix = texts.get('deployment:persona-prefix') ?? ''
  const suffix = texts.get('deployment:persona-suffix') ?? ''
  const complete = detectCompleteSection(assembly)
  const warnings = complete === undefined ? [] : [
    `dsh-arbor: DSH section "${complete}" declares complete: true, which would replace arbor's whole `
    + 'prompt; an arbor session keeps its own rules, so the persona is used as ordinary text',
  ]
  const unknown = [...promptVariablesOf(prefix), ...promptVariablesOf(suffix)]
    .filter(name => !DSH_PROMPT_VARIABLES.includes(name))
  if (unknown.length > 0) {
    warnings.push(`dsh-arbor: the deployment persona carries prompt variables DSH does not register: ${[...new Set(unknown)].join(', ')}`)
  }
  return { prefix, suffix, variables: promptVariablesOf(prefix), warnings }
}

/** Inputs for {@link dshPromptPlugins}. */
export interface DshPromptPluginOptions extends DshPromptSource {
  /**
   * DSH's `system-prompt/change` counter, raised by the caller whenever a
   * prompt provider changes. Both sections' revisions follow it, so arbor
   * re-renders them only when a DSH section actually changed.
   */
  readonly changeCounter: () => number
  /**
   * The dynamic state the `<harness>` section renders: the approval policy,
   * the sandbox mode, plan mode, and the DSH tools actually exposed. Read per
   * call, because the rendering session's policy is the one that counts.
   */
  readonly state: () => HarnessState
  /** Where a warning goes: DSH's logger, or a test's collector. */
  readonly onWarning?: (message: string) => void
}

/** A stable digest of one rendered section, for tests and diagnostics. */
export function sectionDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * The two arbor plugins that carry DSH into a window's prompt: `dsh-harness`
 * for the trusted `<harness>` section, and `dsh` for the `<dsh>` data block.
 *
 * Two plugins rather than one, because `Plugin` carries one `promptSection`
 * and these are two sections with two different roles: one is framework
 * prompt, the other is third-party data.
 */
export function dshPromptPlugins(options: DshPromptPluginOptions): readonly Plugin[] {
  /**
   * The digest every input of both sections contributes to. It is cheap — no
   * assembly — and it covers everything the content reads: DSH's prompt
   * generation, the approval policy, plan mode, and the set of DSH tools
   * exposed. A revision that moves without the text changing costs one
   * re-render that produces no delta.
   */
  const stateKey = (): string => {
    const state = options.state()
    return [
      options.changeCounter(),
      state.approval ?? '',
      state.planActive ? 'plan' : '',
      [...state.exposedTools].sort().join(','),
    ].join('|')
  }

  /**
   * What the assembly itself depends on, as opposed to what the rendered text
   * depends on.
   *
   * DSH's `plan:policy` and `tool:*` texts read the agent and the tool set, so
   * the assembly has to be redone when either moves; the approval policy is
   * read from the state rather than from DSH's sections, so it does not.
   * Keeping the two keys apart is what stops an approval switch —
   * which happens between turns — from re-assembling DSH's prompt in the host's
   * watch loop, where the turn that would have supplied a live signal has
   * already ended.
   */
  const assemblyKey = (): string => {
    const state = options.state()
    return [
      options.changeCounter(),
      state.planActive ? 'plan' : '',
      [...state.exposedTools].sort().join(','),
    ].join('|')
  }

  /**
   * One assembly per change, shared by both sections.
   *
   * `renderPluginSections` renders the sections back to back, and arbor renders
   * them again for a delta, so without this the host would assemble DSH's
   * prompt four times per epoch.
   */
  let assembled: { key: string; assembly: Promise<PromptAssembly> } | undefined
  const assemble = (): Promise<PromptAssembly> => {
    const key = assemblyKey()
    if (assembled?.key === key) return assembled.assembly
    const agent = agentOf(options)
    const assembly = options.systemPrompt.assemble({
      ...agent === undefined ? {} : { agent, scope: agent },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    assembled = { key, assembly }
    return assembly
  }

  const warn = (message: string): void => {
    options.onWarning?.(message)
  }

  /**
   * One render pass at a time, across both sections and every window.
   *
   * Arbor reads a section's `outside` flag immediately after its `content()`
   * resolves, and the `<dsh>` section's flag is what the pass just computed, so
   * two passes running at once could read each other's answer: a window with
   * third-party material would lose its data mark, or a window without any
   * would gain one. The passes are sequential anyway — the host renders a
   * window's sections back to back in one watch-loop step — so serializing them
   * costs nothing and makes the flag mean what it says.
   */
  let pass: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = pass.then(work, work)
    pass = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * The last blocks each section rendered, so a render that fails keeps the
   * window's prefix rather than taking the window down.
   *
   * A plugin section's `content()` is awaited inside the host's watch loop, and
   * an exception there is swallowed by the loop's own error handling — which
   * would leave the window unsettled and never ended. DSH's assembly does
   * filesystem I/O and reads the rendering agent's fiber, so a section rendered
   * after its session went away can legitimately fail; the section then keeps
   * what it last said and the failure is recorded.
   */
  const last = new Map<string, readonly Block[]>()
  const renderSection = async (
    tag: string,
    build: (assembly: PromptAssembly) => readonly Block[],
  ): Promise<readonly Block[]> => enqueue(async () => {
    try {
      const blocks = build(await assemble())
      last.set(tag, blocks)
      return blocks
    } catch (error: unknown) {
      const held = last.get(tag)
      if (held !== undefined) {
        warn(`dsh-arbor: the <${tag}> section could not be re-rendered `
          + `(${error instanceof Error ? error.message : String(error)}); the window keeps what it last read`)
        return held
      }
      throw error
    }
  })

  /**
   * Whether the last `<dsh>` pass found anything from outside the framework.
   *
   * Arbor wraps an outside plugin section in a block that always states its
   * lead line, so a section registered `outside: true` renders a `<dsh>` that
   * says "this is data" about nothing whenever DSH registers no third-party
   * section — which is the default case. The flag is therefore only set when
   * there is material, and `<dsh>` is absent otherwise, along with the
   * precedence rule in `<agent>` that exists for the same reason.
   */
  let dshOutside = false

  return [
    {
      name: 'dsh-harness',
      promptSection: {
        tag: 'harness',
        blocks: HARNESS_BLOCKS,
        text: dshTextTable,
        content: async () => renderSection('harness', (assembly) => {
          const complete = detectCompleteSection(assembly)
          if (complete !== undefined) {
            warn(`dsh-arbor: DSH section "${complete}" declares complete: true; arbor keeps its own rules`)
          }
          return renderHarness(assembly, options.state()).blocks
        }),
        revision: () => sectionDigest(stateKey()),
      },
    },
    {
      name: 'dsh',
      promptSection: {
        tag: 'dsh',
        blocks: [DSH_DATA_BLOCK],
        text: dshTextTable,
        content: async () => renderSection('dsh', (assembly) => {
          const thirdParty: PromptAssembly = {
            ...assembly,
            sections: assembly.sections.filter(section => decideSection(section.name) === 'outside'),
          }
          const text = renderPrompt(thirdParty)
          // Nothing from outside means no block at all. A `data` block with an
          // empty field still renders its `<data>` wrapper and the data mark,
          // which is a section that says "this is data" about nothing.
          dshOutside = text !== ''
          return dshOutside ? [dataBlock(text)] : []
        }),
        revision: () => sectionDigest(stateKey()),
        // Only while there is material: see `dshOutside`. A section that is
        // outside with nothing to say still renders its lead line, which is the
        // empty `<dsh>` block this avoids.
        get outside(): boolean {
          return dshOutside
        },
      },
    },
  ]
}
