# B0 findings: arbor as DSH's agent driver

Every finding below is backed by a proof in `proofs/` (run `pnpm proofs`), and
every DSH claim names the source location it rests on. DSH is tag
`dsh-v0.2.2-rc.1` (commit `66491b05e3`); arbor is `2026.1106.1`.

## 1. Per-preset routing with an embedded AgentLoop — works

DSH allows one AgentFactory per process: `AgentRegistry.setFactory` throws
`'an agent factory is already registered'` on a second registration
(`packages/core/agent/src/index.ts`, `setFactory` ~L383-399), and AgentLoop
claims that single slot in its own `[Service.init]`
(`packages/core/agent-loop/src/index.ts` L336). So a second factory cannot be
registered alongside the loop, and an isolated service cannot see the parent's
agents: `ctx.isolate('agents')` gives a child scope an independent service
scope (`vendor/cordis/src/context.ts` L121-127) whose reads have no parent
fallback (`vendor/cordis/src/reflect.ts` `_getImpl` L252-256).

A bundle patch also cannot swap which package a row mounts: `applyPatches`
treats a patch's `name` as a check only and skips the patch on a mismatch
(`vendor/include/src/patch.ts` L97-100). The base `agent` row
(`packages/bundle/base/cordis.patch.yml` L82-84) is therefore disabled and a
new row inserted — row order carries no load semantics (activation is
service-availability driven), so the insert position does not matter.

The routing registry (`packages/arbor-agent/src/registry.ts`) keeps two
factories:

- the official AgentLoop, captured when it registers itself through the
  overridden `setFactory` — never passed to the base class, so the base slot
  stays free and nothing throws; and
- the arbor driver, registered through `useArborFactory`.

`create` routes on `options.meta.agentPreset === 'arbor'`; `resume` asks the
driver whether the persisted session is an arbor session
(`CreateAgentOptions.meta.agentPreset`, `packages/core/agent/src/index.ts`
~L66-123). Both paths delegate exactly the way the base class does
(`getTraceable` + `Reflect.apply` through the caller-traced receiver,
`packages/core/agent/src/index.ts` L416-441), so the embedded loop keeps
creating its agents into this same registry instance.

Proof 1 boots the profile with the arbor overlay and shows, in one process: the
base row disabled and the subclass active, the `agent-loop` row untouched and
active with its shipped config, `ctx.agents` an `ArborAgentRegistry`, the
embedded `AgentLoop` captured, an ordinary session running a full turn on the
embedded loop against the real DeepSeek model (`pong`), and an
`agentPreset: 'arbor'` session created and driven through the arbor driver.

## 2. A user message reaches an arbor window and the answer comes back, streamed — works

One DSH user session drives one arbor window. The driver
(`packages/arbor-agent/src/driver.ts`) owns, per session, an `Arbor` host with
the DSH-backed `AgentBackend` (`packages/arbor-llm`) and the prompt plugin
(`packages/arbor-prompt`), and opens the window through `host.dispatch` on the
session's first turn. The session agent
(`packages/arbor-agent/src/session-agent.ts`) implements the full `Agent`
contract that `packages/core/agent/src/runtime-types.ts` augments onto `Agent`
— the same surface `ReactLoopAgent` implements — and drives the window through
a bridge.

The turn/step machine mirrors `packages/core/agent-loop/src/agent.ts`:

- `followup`/`steer`/`inject` splice the durable inbox and wake the driver,
  exactly like the official loop (`packages/core/agent-loop/src/inbox.ts`,
  `ReactLoopInbox`: a splice is a durable `agent/inbox/spliced` event plus
  `agent/inbox/inserted` notifications; `claim` is a splice plus
  `agent/inbox/claimed`). The arbor inbox projection is the same definition
  (key `inbox`, stateVersion 1), refcounted alongside AgentLoop's own
  registration — `SessionProjectionRegistry.register` shares one definition
  per key (`packages/session/session-projection/src/index.ts`, `acquire`).
- Each step assembles the model request from the session log, exactly like
  `ReactLoopAgent.buildRequest` (`packages/core/agent-loop/src/agent.ts`
  ~L653): `session.deriveMessages()`, `session.toolHistory()`, a logged
  `request/header`, and `ctx.llm.prepareCall` + `ctx.llm.stream`
  (`packages/llm/llm/src/index.ts`, `LlmRuntime.prepareCall` ~L960,
  `stream` ~L1170).
- Streaming is framed by a compact mirror of `AssistantStreamAttempt`
  (`packages/core/agent-loop/src/assistant-stream.ts`) built from the public
  `AssistantStreamAccumulator` / `BlockAssembler` primitives
  (`@deepseek-ai/dsh-llm`): frames go out as start → chunk* → end, and the
  terminal frame is emitted only after the durable `assistant/message` append
  commits.
- Tool calls are routed through arbor's own tool path
  (`host.windowControl().recordToolCall` / `runToolCall`) into
  `ctx.tools.execute` with the user session's agent, so DSH appends the
  `tool/call` + `tool/result` pair itself
  (`packages/core/tools/src/batch.ts`, `BatchSettlement` ~L241-266).

Proof 2 passes twice: with a scripted model (deterministic; one tool call then
one text answer) and, with `ARBOR_PROOF_LIVE=1`, against the real DeepSeek
model. Observed on the user session's log:
`turn/start → step/start → system/message → user/message → request/header →
assistant/message → tool/call → tool/result → step/end → step/start →
assistant/message → step/end → turn/end`, with ordered
`start → chunk* → end:committed` frames and the window's own event bus
carrying `tool_call`, `tool_result`, `text_delta` and `run_ended`.

## 3. Window agents stay out of the session list — works

When the driver opens a window it registers the window as a DSH agent with
`meta.origin: 'subagent'`, owned by the user session's agent — the convention
`packages/subagent/subagent/src/child-agent.ts` uses for delegated children
(meta: `origin: 'subagent'`, `parentSession`, `delegationDepth` ~L133-152). The
shipped sidebar rule then leaves it out:
`packages/client/ui-workspace/src/client/tree.ts`, `sessionVisible` ~L229-245,
`if (session.origin === 'subagent') return false` (the published client bundle
carries the same rule: `@deepseek-ai/dsh-client-ui-workspace` lib/client.js).

Proof 3 asserts the durable facts that rule reads: the window session's header
carries `origin: 'subagent'` and `parentSession`; the user session carries no
origin; the window agent is owned (`ctx.agents.isOwnedBy`) and not a registry
root while the user session agent is; and the rule itself excludes the window
session while keeping the user session visible.

## 4. A tool call needing approval reaches DSH's approval path — works

The tool bridge passes the user session's agent into `ctx.tools.execute`, which
is what makes DSH's own approval machinery apply:

- an execution without an agent degrades to deny, and the ask goes to the
  composed approval service (`packages/core/tools/src/pipeline.ts`,
  `serviceAsk` ~L431-475);
- the ask/decide audit pair must sit inside an open turn, and the decision
  waterfall is dispatched in the requesting agent's scope
  (`packages/interaction/user-approval/src/index.ts`, `request` ~L242-250 and
  `decide`).

Proof 4 covers all three outcomes: a grant (the answerer registered on the user
session agent's scope sees the ask with `req.agent` equal to the user session,
the audit pair lands inside its open turn, the tool runs and the model sees the
result), a rejection (the tool does not run, the model sees
`the user rejected tool "spike_ask"`), and no answerer at all (the ask fails
closed as `unavailable`).

## 5. Prompt assembly: official sections dropped, third party in `<dsh>` — works

The prompt bridge (`packages/arbor-prompt`) registers an arbor `Plugin` whose
prompt section is a `<dsh>` block with `outside: true`
(`@4fu/arbor-interfaces/plugin.d.ts`, `PromptSection.outside`: "material from
outside the framework … the framework's own prompt wins on conflict"). Its
content is DSH's assembly with the official sections removed:
`ctx.systemPrompt.assemble({ agent, scope: agent })`
(`packages/core/system-prompt/src/index.ts`, `assemble` ~L621) filtered by
section name and rendered with DSH's own `renderPrompt` (~L297), so the
`{{model}}` / `{{provider}}` variables AgentLoop registers
(`packages/core/agent-loop/src/index.ts` L337-338) are interpolated by DSH, not
re-implemented.

The official-section rule is a prefix list plus exact-name outliers, derived
from every non-test `systemPrompt.section({ name: … })` registration in
deepseek-harness at this tag (`harness:`, `deployment:`, `tool:`, `context:`,
`plan:`, `team:`, `subagent:`, `approval:`, `mcp:`, `jobs:`, `schedule:`,
`workflow:`, `session:`, `ui:`, `ptc:`, `browser-use:`, `computer-use:`,
`terminal:`, `ralph:`, plus the unprefixed `mcp-resource-servers`).

The section's `revision()` follows DSH's own `system-prompt/change`
notifications, so arbor re-renders the block only when a DSH section actually
changed and delivers the changed lines to a live window as a `prompt_delta`.

Proof 5 registers a third-party section (`acme:policy`) as a plugin would, runs
one arbor turn, and checks what the model saw: the window's prompt carries
arbor's own `<identity>`, `<agent>` (with the precedence rule, present because
an outside section exists) and `<tools>`; the third-party text is inside
`<dsh>`; and not one of the 18 official section texts (2587 rendered
characters) survives. The split is taken from DSH's own assembly, not a
hardcoded list, so the check covers whatever the shipped profile registers.

## 6. Common DSH plugins still working — works

The overlay replaces one row and adds three; every other row is exactly as
shipped. Proof 6 checks seven common rows active (`tool-todo`, `tool-skill`,
`plan-mode`, `agent-instructions`, `subagent`, `approval`, `tool-goal`), their
prompt sections and contexts registered (`plan:policy`, `tool:goal`,
`approval:policy`, `harness:identity`), and then runs a common plugin's tool on
both paths in one process: `todo_write` through the arbor bridge writes its
`todo/write` event onto the user session's log (which only happens because the
call carries the user session's agent — the tool rejects a non-agent caller,
`packages/todo/tool-todo/src/index.ts` ~L198), and the same tool runs on an
ordinary embedded-loop session.

## What did not work, and what is deliberately out of B0 scope

- **`resume` of a persisted arbor session** fails with a descriptive error.
  Rebuilding the arbor window from its journal with a relay cursor (which arbor
  event has already been mirrored onto the DSH session log) is B1 work. The
  registry still routes non-arbor resumes to the embedded loop, and asks the
  driver first (`ownsSession`), so ordinary sessions resume normally.
- **`ctx.isolate('agents')`** does not work as an embedding strategy (source
  citations in section 1); the routing registry is the answer.
- **A patch cannot swap a row's package** (section 1); rows are replaced, not
  edited.
- **Compaction, goals, agentTeams, retry and fork are off** for arbor sessions,
  per the plan. `agent/request-error` is therefore not dispatched for arbor
  sessions: a model failure surfaces as `agent/error` and a `turn/end` with an
  error reason, and the turn closes.
- **`agent/pre-step` message rewrites are ignored** (only `reject` is honored),
  so `installModelSelection`'s model-switch notice
  (`packages/core/agent/src/model-selection.ts`) does not fire on a mid-session
  model change in an arbor session.
- **The system prompt is admitted once per session.** The official loop's
  in-history system-prompt projection
  (`packages/core/agent-loop/src/runtime-context.ts`, `SystemPromptProjection`)
  is not mirrored; a long arbor session keeps its first prompt.

## What arbor's core is still missing (back to the arbor repo)

1. **No `Journal` implementation ships.** The core defines the interface
   (`@4fu/arbor-interfaces/journal.d.ts`) and the host rebuilds every running
   window from the journal after a restart (`host.d.ts`, `start`), but a
   deployment provides the journal. B0 wrote an in-memory one
   (`packages/arbor-testkit/src/journal.ts`). B1 needs a durable journal —
   without it an arbor session does not survive a restart, and the B0 resume
   gap above cannot close.
2. **`AgentBackend.externalTools()` is read exactly once**
   (`@4fu/arbor-core/host.js`, `loadHost` ~L331: "read once, here, so the first
   window opens with them"). A DSH tool registered after the host's first load
   never reaches the model until restart. B1 needs either a re-read seam or a
   DSH-side push that re-opens the window.
3. **`DirectToolSpec`/`ParameterSpec` is too small for DSH tool schemas.** The
   round trip DSH JSON Schema → `ParameterSpec` → JSON Schema drops `enum`,
   `items`, `additionalProperties` and nesting: the model sees `todo_write`'s
   `todos` as a bare array with no item shape and no status enum (measured in
   B0). B1 either extends the parameter spec or passes the DSH schema through
   verbatim.
4. **`WindowSession.steer` / `followUp` deliveries have no DSH consumer in
   B0.** Arbor-side inputs — reminders, `prompt_delta`s, notices and broadcasts
   from other windows — arrive at the backend and are queued. B1 must map them
   onto DSH's `agent.inject` (next-step context) or steering, as
   `agent/inbox/spliced` events on the user session.
5. **The judge is model-based.** B0 turns every judge mode off in settings
   (`judge.modes`, all `off`), which makes `host.dispatch` deterministic: one
   window per session, opened on the first turn. B1 must decide the routing
   policy — one window per session, or judge-routed windows with expectations.
6. **`models()` / `login()` are placeholders and the tier mapping is unused**:
   the window's model always comes from the DSH session's model selection, not
   from `settings.modelTiers`. B1 decides whether arbor tiers map onto DSH
   routes at all.
7. **`windowStream` observation needs a registered hook**: arbor streams a
   window's live output only to hooks (`host.js`, `streamOut`). B0 observes the
   window bus directly through the driver's test accessor.

## Recommended module layout for B1

The B0 packages map one-to-one onto the plan's modules; B1 keeps the split and
adds the host, workspace, env, client, bundle and preset modules:

```
@4fu/dsh-arbor-host        owns the Arbor hosts: one per process or per
                           session (B1 decides), the durable journal in
                           DSH_HOME/arbor/, the settings, the supervisor and
                           the workspace mount. B0's driver does this inline.
@4fu/dsh-arbor-driver      the routing AgentRegistry subclass, the arbor
                           AgentFactory, the session agent, the driver, the
                           window-agent registration and the resume path.
                           (B0: packages/arbor-agent.)
@4fu/dsh-arbor-llm         the AgentBackend over ctx.llm, the window session,
                           the request/header logging and the relay cursor
                           for resume. (B0: packages/arbor-llm.)
@4fu/dsh-arbor-prompt      the <dsh> bridge: official sections dropped,
                           third-party sections carried, revisions following
                           system-prompt/change, prompt_delta applied to live
                           turns. (B0: packages/arbor-prompt.)
@4fu/dsh-arbor-tools       the tool bridge: DSH tools as external tools, the
                           faithful schema mapping, official same-name tools
                           replaced by arbor's own and the rest restricted.
                           (B0: packages/arbor-tools.)
@4fu/dsh-arbor-workspace   the arbor Workspace implementation over DSH's
                           sandboxed fs (ctx.fs), so windows work in the
                           session's cwd.
@4fu/dsh-arbor-env         /env: DSH's skills and MCP servers mounted read-only
                           into arbor's environment catalog.
@4fu/dsh-arbor-client      the UI surface for arbor windows (board, streaming,
                           approvals) beside DSH's own.
@4fu/dsh-arbor-bundle      the bundle package: cordis.patch.yml with the row
                           swaps, the manifest and the locales.
@4fu/dsh-arbor-preset      the agent-preset row that selects arbor for a
                           session (meta.agentPreset: 'arbor').
@4fu/dsh-arbor-testkit     the boot harness, the memory journal, the scripted
                           model and the proof fixtures. (B0: packages/arbor-testkit.)
```

Two decisions B1 should take early, both flagged by the spike:

- **Host lifetime**: one Arbor host per process (windows across sessions share
  a board and a journal, and the judge can route between them) or one per DSH
  session (simpler isolation, data under `DSH_HOME/arbor/<session>/`). B0 uses
  one per session.
- **Window lifetime**: B0 keeps a session's window open for the whole session
  (`window.idleSeconds: 86400`). Arbor's default (300 s) ends a window after
  idle and the next turn opens a continuation from the journal; B1 must pick
  the policy and verify the continuation path against the DSH session log.
