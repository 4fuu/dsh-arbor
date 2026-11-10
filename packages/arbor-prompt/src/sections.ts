/**
 * The per-section decision table, pinned to one DSH version.
 *
 * B0 dropped every official DSH prompt section by name prefix. That rule is
 * withdrawn: the system prompt of an arbor window now carries both arbor's
 * logic and DSH's own mechanisms, decided section by section here
 * (`dsh-arbor 提示词、工具与环境对照表`). Every decision is one of:
 *
 *  - `harness` — the section describes something that is still true on the
 *    arbor path, so dsh-arbor writes its own line into the `<harness>`
 *    section. Where DSH's own wording can be carried through unchanged (a
 *    tool's usage text), it is; where it cannot (DSH speaks of the final
 *    response, arbor has `send`), this bridge rewrites it.
 *  - `identity` — the deployment's persona, which belongs in arbor's
 *    `<identity>` section rather than in a section of its own.
 *  - `plan` — plan mode's guidance, written into `<harness>` while plan mode
 *    is active and nowhere while it is not.
 *  - `outside` — third-party material, which goes into the `<dsh>` data
 *    block. Official sections never go there.
 *  - `drop` — the mechanism does not exist on the arbor path, or arbor's own
 *    replaces it. Nothing of it reaches the model.
 *
 * The table is keyed by the section names the pinned DSH registers, so an
 * upgrade that adds a name fails the unknown-section test in
 * `proofs/12-official-sections.ts` and forces the decision to be made then,
 * rather than letting a new section quietly reach the model.
 */

/** The DSH version this table is pinned to. */
export const DSH_PINNED_VERSION = '0.2.2-rc.1'

/** What one official DSH prompt section or runtime context contributes. */
export type SectionDecision = 'harness' | 'identity' | 'plan' | 'outside' | 'drop'

/**
 * Every official section and runtime-context name the pinned DSH registers,
 * with its decision.
 *
 * The names come from every non-test `systemPrompt.section({ name })` and
 * `systemPrompt.context({ name })` registration in the `@deepseek-ai/*`
 * packages at dsh-v0.2.2-rc.1: `harness:identity`,
 * `deployment:persona-prefix`/`-suffix`, `plan:policy`, `team:policy`,
 * `tools:ptc-only`, `tools:sdk`, `ui:deliverable-file-references`,
 * `tool:*` (one per tool package, plus `tool:<name>:depth` for a delegated
 * tool and `tool:structured_output` for a DSH subagent), `mcp:<server>`,
 * `mcp-resource-servers`, `liveshare:*`, and the runtime contexts
 * `working-directory:current`, `sandbox:policy`, `approval:policy`,
 * `subagent:delegation`, `team:identity`, `harness:source`, `web:surface`.
 */
export const DSH_SECTION_DECISIONS: Readonly<Record<string, SectionDecision>> = {
  // ---- third-party material that arrives through an official name --------
  // An MCP server's instructions and the resource-server list are third-party
  // content, so they go into <dsh> as data even though the section name is
  // DSH's own. Their tools arrive as arbor external tools like any other.
  'mcp-resource-servers': 'outside',

  // ---- what the harness itself is ----------------------------------------
  'harness:identity': 'harness',

  // ---- the deployment's persona ------------------------------------------
  // Kept as ordinary persona text inside <identity>. `complete: true` is not
  // honoured for an arbor session — it would replace arbor's whole prompt —
  // and the bridge records a warning when it sees one.
  'deployment:persona-prefix': 'identity',
  'deployment:persona-suffix': 'identity',

  // ---- the dynamic runtime context ---------------------------------------
  // The session's cwd is written by arbor's <workspace> section, and DSH's
  // project management is arbor's for an arbor session (decisions table
  // revision 2): the project is arbor's own shared folder, the window works in
  // its own checkout, and the paths belong to <workspace>. Nothing is written
  // here, and no runtime-context snapshot is delivered either.
  'working-directory:current': 'drop',
  // The two policy lines are dsh-arbor's own, written into <harness>. There is
  // no sandbox line: arbor sessions do not use DSH's sandbox, so a line would
  // name enforcement that does not exist.
  'sandbox:policy': 'drop',
  'approval:policy': 'harness',

  // ---- what the model writes, and how it refers to files ------------------
  'ui:deliverable-file-references': 'harness',
  'context:file-reference': 'harness',

  // ---- plan mode ----------------------------------------------------------
  'plan:policy': 'plan',

  // ---- tools arbor's own replace ------------------------------------------
  // bash / pwsh: arbor's shell tool (`bash`/`bash_output`/`bash_stop` on
  // POSIX, `pwsh`/`pwsh_output`/`pwsh_stop` on Windows).
  'tool:bash': 'drop',
  'tool:pwsh': 'drop',
  // read / write / edit / apply_patch: arbor's file tools.
  'tool:read': 'drop',
  'tool:write': 'drop',
  'tool:edit': 'drop',
  'tool:apply_patch': 'drop',
  // glob / grep: arbor's `workspace` module.
  'tool:glob': 'drop',
  'tool:grep': 'drop',
  // job_*: arbor's shell output and stop tools.
  'tool:jobs': 'drop',
  // schedule_*: arbor's own `schedule` module. DSH's scheduler opens another
  // DSH session, which fights arbor's source model.
  'tool:schedule': 'drop',
  // subagent / subagent_fork: arbor's windows, its broadcast and its window
  // messages. `tool:<name>:depth` is the delegated tool's depth line.
  'tool:subagent': 'drop',
  'tool:subagent_fork': 'drop',
  'tool:subagent:depth': 'drop',
  'tool:subagent_fork:depth': 'drop',
  // goal / team / ralph / workflow / session-query: goals, teams, ralph,
  // workflows and DSH's own history search are closed for arbor sessions;
  // history is arbor's journal.
  'tool:goal': 'drop',
  'tool:ralph': 'drop',
  'tool:workflow': 'drop',
  'tool:session-query': 'drop',
  'tool:structured_output': 'drop',
  'team:policy': 'drop',
  'team:identity': 'drop',
  'subagent:delegation': 'drop',
  // PTC: arbor has its own `code_exec`.
  'tools:ptc-only': 'drop',
  'tools:sdk': 'drop',

  // ---- DSH tools arbor keeps, when they are exposed ------------------------
  // Their usage text is carried through verbatim; the tools themselves arrive
  // as arbor external tools. A tool that is not exposed writes nothing.
  'tool:web_search': 'harness',
  'tool:web_fetch': 'harness',
  'tool:pty': 'harness',
  'tool:lsp': 'harness',

  // ---- DSH development-environment material -------------------------------
  // Only present in a DSH development profile: it names the DSH source
  // checkout and the dev GUI, neither of which an arbor window works with.
  'harness:source': 'drop',
  'web:surface': 'drop',
  'liveshare:viewer-child': 'drop',
  'liveshare:viewer-fork': 'drop',
  'liveshare:viewer-global': 'drop',
  'liveshare:viewer-readable-global': 'drop',
  'liveshare:viewer-readable-session': 'drop',
  'liveshare:viewer-readable-workspace': 'drop',
  'liveshare:viewer-session-read': 'drop',
  'liveshare:viewer-source-write': 'drop',
  'liveshare:viewer-workspace': 'drop',
  'liveshare:viewer-writable-global': 'drop',
  'liveshare:viewer-writable-session': 'drop',
  'liveshare:viewer-writable-workspace': 'drop',
}

/**
 * Prefix rules for the names the pinned DSH builds at runtime rather than
 * writing as literals: `mcp:<server>` for one connected MCP server, and the
 * tool families whose registration is templated. A name that matches no exact
 * entry and no prefix is undecided, which is what the unknown-section test
 * fails on.
 */
export const DSH_SECTION_PREFIX_DECISIONS: Readonly<Record<string, SectionDecision>> = {
  // One MCP server's instructions: third-party material, so <dsh>.
  'mcp:': 'outside',
  // The browser- and computer-use tool families, and DSH's terminal tools:
  // kept verbatim in <harness> while the tool is exposed. The pinned DSH
  // registers none of these three prefixes; they are here so a profile that
  // mounts one gets the same treatment `tool:pty` gets rather than failing.
  'browser-use:': 'harness',
  'computer-use:': 'harness',
  'terminal:': 'harness',
}

/**
 * Whether one DSH prompt section or runtime context is official — registered
 * by a `@deepseek-ai/*` package rather than by a plugin.
 *
 * This is a question about the name's origin, not about the table: an official
 * section can still be decided `outside` (an MCP server's instructions arrive
 * through the official `mcp:<server>` name, and they are third-party content),
 * and a third-party section is always `outside`.
 */
export function isOfficialSection(name: string): boolean {
  return DSH_OFFICIAL_SECTION_NAMES.includes(name)
    || DSH_OFFICIAL_SECTION_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * Official DSH prompt-section name prefixes.
 *
 * Derived from every non-test `systemPrompt.section({ name: ... })` and
 * `systemPrompt.context({ name: ... })` registration in the `@deepseek-ai/*`
 * packages at dsh-v0.2.2-rc.1, grouped by the taxonomy
 * packages/core/system-prompt/src/index.ts SECTION_ORDERS and CONTEXT_ORDERS
 * define: `harness:`, `deployment:`, `tool:`, `context:`, `plan:`, `team:`,
 * `subagent:`, `approval:`, `mcp:`, `jobs:`, `schedule:`, `workflow:`,
 * `session:`, `ui:`, `ptc:`, `browser-use:`, `computer-use:`, `terminal:`,
 * `ralph:`, `liveshare:`.
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
  'sandbox:',
  'working-directory:',
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
  'liveshare:',
]

/**
 * Official section names that carry no prefix of their own: the exact
 * registrations in the `@deepseek-ai/*` packages at dsh-v0.2.2-rc.1 whose
 * names sit outside the taxonomy (`packages/mcp/mcp-resources/src/index.ts`).
 */
export const DSH_OFFICIAL_SECTION_NAMES: readonly string[] = [
  'mcp-resource-servers',
]

/** The decision the table makes for one name, or `undefined` when it makes none. */
export function decisionFor(name: string): SectionDecision | undefined {
  const exact = DSH_SECTION_DECISIONS[name]
  if (exact !== undefined) return exact
  for (const [prefix, decision] of Object.entries(DSH_SECTION_PREFIX_DECISIONS)) {
    if (name.startsWith(prefix)) return decision
  }
  return undefined
}

/** The decision the table makes for one name, or `outside` for a third party's. */
export function decideSection(name: string): SectionDecision {
  return decisionFor(name) ?? 'outside'
}

/** Every official name the table decides, exact entries and prefixes alike. */
export function officialSectionNames(): readonly string[] {
  return [
    ...Object.keys(DSH_SECTION_DECISIONS),
    ...Object.keys(DSH_SECTION_PREFIX_DECISIONS),
  ]
}
