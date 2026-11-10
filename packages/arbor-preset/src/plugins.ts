/**
 * The DSH preset rows an arbor session mounts, pinned to `dsh-v0.2.2-rc.1`.
 *
 * The arbor preset used to declare `plugins: []`. Everything arbor replaces is
 * its own direct tool, but DSH's preset-level tools are not registered anywhere
 * else: a session whose preset declares no row never has `web_search`,
 * `present`, `ask_user_question`, plan mode, the Cordis tools, or a persistent
 * terminal. This list is the explicit allow side. The deny side is
 * `DSH_TOOLS_ARBOR_REPLACES` in `@4fu/dsh-arbor-tools`, and the two are checked
 * against each other by `proofs/27-windows-tools.ts`.
 *
 * Every row is copied from DSH's own preset at the pin:
 *
 *  - `tool-web`, `tool-ask-user`, `tool-todo`, `present`, `planning`,
 *    `tool-plugin-manager` from `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`;
 *  - `tool-cordis` from `presets/cordis.patch.yml`;
 *  - the persistent-terminal group from
 *    `@deepseek-ai/dsh-experimental-terminal-bundle/cordis.patch.yml`, with its
 *    two platform-conditioned backends kept as that bundle declares them.
 *
 * Rows that duplicate arbor are deliberately absent: `tool-bash`/`tool-pwsh`,
 * `tool-fs`'s read/write/edit/apply_patch (the row is mounted for `read_image`
 * only, which arbor's text-only `read` cannot do), `tool-fs-search`,
 * `tool-jobs`, `tool-schedule`, the delegation group, `command-goal`/`tool-goal`,
 * `skill-filesystem`/`tool-skill`, and the compaction group. A DSH tool the
 * deployment registers elsewhere still reaches arbor through `externalTools`
 * unless its name is on the deny list; the allowlist is about the preset rows a
 * stock arbor session must have, not about hiding a deployment's own tools.
 *
 * `lsp` is conditional on purpose: DSH 0.2.2-rc.1 ships no LSP service in its
 * standard install, and `dsh-tool-lsp` needs `ctx.lsp` plus a configured
 * provider. A deployment that mounts the service gets the tool; one that does
 * not gets no half-working row. Browser-use and computer-use are the same
 * shape: the shipped packages are provider registries and expose no model tool
 * by themselves, so a deployment that enables a provider supplies that provider
 * row in the preset config and its tools arrive through `externalTools`.
 */

import type { JsExpr } from '@deepseek-ai/cordis-plugin-loader'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** The DSH version every row here is copied from. */
export const PRESET_PINNED_VERSION = '0.2.2-rc.1'

/**
 * DSH's plan-mode guidance, copied verbatim from the pinned standard preset.
 *
 * Plan mode's section is the deployment's own text, so this bridge keeps DSH's
 * wording rather than writing one of its own; `plan:policy` decides when it is
 * rendered, and `exit_plan_mode` arrives through the row's tool registration.
 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

/** One preset row, as DSH's own preset files declare it. */
type PresetPlugin = PresetDefinition['plugins'][number]

/** A loader `!!js` expression, which a JSON value cannot carry. */
function when(expression: string): JsExpr {
  return { __jsExpr: expression }
}

/**
 * The preset rows an arbor session mounts.
 *
 * `platform` is a parameter rather than `process.platform` alone so the Windows
 * composition can be checked on a POSIX host: the two terminal backends are
 * the only platform-conditioned rows, exactly as in DSH's own terminal bundle.
 */
export function arborPresetPlugins(platform: NodeJS.Platform = process.platform): readonly PresetPlugin[] {
  const windows = platform === 'win32'
  return [
    // Web search and fetch: DSH's tools, arbor's <harness> carries their usage.
    // `web_search` still follows DSH's own admission rule: a step sees it only
    // when the selected search provider can authenticate, while `web_fetch`
    // needs only the http provider. The bridge reads the admitted set, so the
    // prompt and the model request agree in either case.
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
    // A question to the user, answered through DSH's own UI.
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    // todo_write: implementation tracking after an approved plan; plan mode's
    // own text says not to use it during planning.
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    },
    // Deliverable files the user can open in DSH.
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    // read_image is the one capability of DSH's file tools arbor's text-only
    // read does not have. The row is mounted with every mutating tool off, so
    // read/write/edit/apply_patch stay arbor's own.
    {
      id: 'read-image',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { read: false, readImage: true, write: false, edit: false, applyPatch: false },
    },
    // Plan mode: the deployment's guidance plus exit_plan_mode. The isolate is
    // DSH's own, so the plan state is per session rather than process-wide.
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: { section: PLAN_MODE_SECTION },
        },
      ],
    },
    // The Cordis inspection tools, for reading exact service, event, config and
    // slot shapes before writing a plugin. The web profile mounts the inspect
    // providers; a headless deployment has none, and a row waiting for
    // `cordisInspect` would make the whole preset fail to mount.
    {
      id: 'tool-cordis',
      name: '@deepseek-ai/dsh-tool-cordis',
      disabled: when("!ctx.get('cordisInspect')"),
    },
    // Plugin management, where DSH has a profile to manage.
    {
      id: 'tool-plugin-manager',
      name: '@deepseek-ai/dsh-plugin-manager/tools',
      disabled: when("!ctx.get('profileContext')"),
    },
    // LSP: only where the deployment already mounted the seam and a provider.
    {
      id: 'tool-lsp',
      name: '@deepseek-ai/dsh-tool-lsp',
      disabled: when("!ctx.get('lsp')"),
    },
    // Persistent terminals (pty), with the same platform split DSH's own
    // terminal bundle declares: the bash backend on POSIX and the same package
    // in pwsh dialect on Windows.
    {
      id: 'terminals',
      name: 'cordis:group',
      group: true,
      isolate: { terminals: true },
      config: [
        { id: 'terminal-registry', name: '@deepseek-ai/dsh-terminal' },
        {
          id: 'terminal-bash',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: windows,
        },
        {
          id: 'terminal-pwsh',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: !windows,
          config: { shellDialect: 'pwsh' },
        },
        { id: 'tool-terminal', name: '@deepseek-ai/dsh-tool-terminal' },
      ],
    },
  ]
}
