# dsh-arbor

arbor as DeepSeek Harness's agent driver: one Arbor host per DSH process, one
window per user session, and the reply streamed back as an ordinary assistant
message on the session log. Sessions that do not ask for arbor keep running on
DSH's own embedded AgentLoop, in the same process.

- DSH is pinned to tag `dsh-v0.2.2-rc.1` (commit `66491b05e3` of
  deepseek-ai/deepseek-harness); the packages install the published
  `@deepseek-ai/dsh@0.2.2-rc.1` tree, so no monorepo build is needed.
- arbor is pinned to `2026.1106.1` (`@4fu/arbor-*` from npm).
- Node 24+ (developed on Node 26; the sources are erasable-syntax TypeScript
  run directly through Node's type stripping, so there is no build step).

> **Installing or inspecting this repository?** Hand the work to a model with
> [docs/install-for-agents.md](docs/install-for-agents.md): a step-by-step
> document written for an AI agent — clone, install, check, run the proofs,
> drive a live turn including a restart, and inspect what ran. It is accurate to
> what works today and says what does not.

## Install

```bash
git clone https://github.com/4fuu/dsh-arbor
cd dsh-arbor
git checkout b1
pnpm install        # pnpm 11+; the dependency build policy is in pnpm-workspace.yaml
pnpm check          # tsc --noEmit over every package and proof
pnpm proofs         # all eleven proofs, against the scripted model
```

One prompt to hand to a model, so it installs and inspects this according to
your needs — edit the bracketed parts, or drop them:

```text copy Copy Install Prompt
Install dsh-arbor (https://github.com/4fuu/dsh-arbor, branch b1) in this
environment [in a scratch clone under /tmp] and show me that it works: follow
docs/install-for-agents.md, run pnpm install, pnpm check and pnpm proofs, and
[also drive one live turn against the real DeepSeek model, with a DSH restart
and resume in the middle]. Report which proofs passed, what the live turn
answered, and anything that did not work. Fix only what is yours to fix and
tell me what you changed.
```

## Run the proofs

Each proof prints one `PASS`/`FAIL` line per assertion plus a final
`PROOF n OK`, and each runs alone:

```bash
pnpm proof:boot        # 00 the boot harness: the shipped profile, one turn
pnpm proof:routing     # 01 per-preset routing with an embedded AgentLoop
pnpm proof:roundtrip   # 02 message -> arbor window -> assistant message, streamed
pnpm proof:hidden      # 03 window agents hidden from the session list
pnpm proof:approval    # 04 a tool call needing approval reaches DSH's approval path
pnpm proof:prompt      # 05 prompt assembly (B0's rule, kept until B2)
pnpm proof:plugins     # 06 common DSH plugins still working
pnpm proof:preset      # 07 the arbor preset in the roster, routing both ways
pnpm proof:storage     # 08 durable storage, one host, workspace root
pnpm proof:lifetime    # 09 window end, continuation, idle timeout
pnpm proof:resume      # 10 resume of a persisted session after a restart
```

The default run uses a scripted model, so it needs no key and no network.
Against the real DeepSeek model instead:

```bash
ARBOR_PROOF_LIVE=1 pnpm proofs          # or a single proof
```

## What each proof shows

| Proof | Integration point | Result |
| --- | --- | --- |
| 00 | Boot harness | shipped `headless` profile boots from npm; one turn runs |
| 01 | Per-preset routing | base `agent` row replaced by a routing registry; ordinary sessions keep running on the embedded official AgentLoop, `agentPreset: 'arbor'` sessions run through the arbor driver, both in one process |
| 02 | Round trip + streaming | a user message reaches an arbor window; the window's answer comes back as `assistant/message` with ordered `agent/assistant-stream` frames; a tool call runs through arbor's tool path into `ctx.tools.execute` |
| 03 | Window agents hidden | each window is registered with `meta.origin: 'subagent'`, owned by the user session's agent; the shipped sidebar rule leaves it out |
| 04 | Approvals | an `ask` tool call reaches `ctx.tools.execute` with the user session's agent, the ask/decide audit pair lands inside its open turn, and grant / reject / fail-closed all behave |
| 05 | Prompt assembly | every official section DSH itself assembled is absent from the window's prompt, with no survivor; the third-party section arrives inside the arbor `<dsh>` outside block |
| 06 | Common plugins | seven common plugin rows active, their sections registered, `todo_write` runs on the arbor path and on the embedded-loop path |
| 07 | Preset + routing | the preset is in the roster and selectable, its selection is on the log, the arbor session runs through the driver and the ordinary session in the same process is untouched |
| 08 | Storage + workspace | data under `DSH_HOME/arbor/` with a SQLite journal and note store, one host for two sessions of different cwds, arbor's own window defaults, the judge off, a window's directory under its session's cwd, the `<workspace>` section naming it |
| 09 | Window lifetime | a window the model ends hands off to a continuation the next turn drives; an idle window ends and the next turn opens a new window of the chain; one system prompt; no dangling tool calls |
| 10 | Resume | the relay's own logic on synthetic input, a clean restart that resumes onto the window the host continued, and an interrupted restart whose journal-recorded call the log lost is replayed and closed as outcome-unknown |

Findings, the exact DSH source locations each one rests on, what arbor's core is
still missing, and the recommended module layout:
[docs/b0-findings.md](docs/b0-findings.md).

## Layout

```
patches/            overlay patch layers applied above the shipped profile
  control.patch.yml   the shipped profile with its one-shot runner rows disabled
  arbor.patch.yml     control + the routing registry, driver and journal rows
  scripted.patch.yml  the scripted provider route and test tools (no network)
  prompt.patch.yml    a third-party prompt section, as a plugin would register
  lifetime.patch.yml  arbor's window idle overlay, for the lifetime proof
  preset-registry.patch.yml  the preset roster row, for the preset proof
packages/
  arbor-host/       the one Arbor host per process: the durable SQLite journal
                    and note store under DSH_HOME/arbor, the settings, the
                    window lifecycle, the per-session-cwd workspace
  arbor-driver/     the routing AgentRegistry subclass, the AgentFactory, the
                    session agent, the inbox and stream mirrors, and the relay
                    that replays the journal onto a resumed session
  arbor-llm/        the arbor AgentBackend: each window's turns run through
                    DSH's ctx.llm and ctx.tools
  arbor-prompt/     the prompt bridge: <dsh> outside block, official sections
                    dropped by name prefix (B0's rule, kept until B2)
  arbor-tools/      the tool bridge: DSH tools as arbor external tools
  arbor-bundle/     the installable bundle: cordis.patch.yml with the row swaps,
                    the manifest and the locale
  arbor-preset/     the agent-preset row that puts arbor in DSH's roster
  arbor-testkit/    the boot harness, the memory journal, the scripted model,
                    the gate and the typed row accessors
proofs/              one runnable proof per integration point
```

The overlay pattern is the one DSH's own tests use
(`packages/test-support/loader-smoke/tests/fixtures/production-profile.ts`,
`packages/experimental/subagent-oar/tests/fixtures/loader/`), anchored on the
npm-published `@deepseek-ai/dsh` installation instead of `apps/cli`. The proofs
load the bundle's own patch file as their first overlay, so what a proof boots
is exactly what an installed bundle composes.

## B1 status

Works, and each item has a proof: per-preset routing with the embedded loop
untouched; one Arbor host per process with durable storage under
`DSH_HOME/arbor/`; a window per session working in that session's cwd; a
window's end handing off to a continuation, and an idle window ending on
arbor's own defaults; resume of a persisted session after a restart, replaying
from the journal; one `tool/call` + `tool/result` pair per window tool call;
approvals, the common plugins, and the streamed reply.

Deliberately out of B1, and not worked around here:

- The prompt bridge is still B0's drop-by-prefix rule. B2 replaces it with the
  per-section decisions in the B2 plan, and leaves a seam for it
  (`isOfficialSection`, the two lists it reads, `renderDshSections`).
- The tool bridge maps DSH's JSON Schema to arbor's parameter specs lossily for
  exotic schemas, arbor's own tools run unsandboxed, and no official same-name
  tool is replaced yet. The journal records each refused registration as
  `tool_registration` with `rule: "tool.name_taken"`.
- The judge is off: every judge decision is model-based, and a model-based judge
  cannot run through the DSH backend yet.
- The arbor preset cannot be driven from DSH's one-shot CLI runner, which
  refuses to adopt any session that runs under a preset; a surface that
  composes presets (the TUI or web client, or the SDK path the proofs use) is
  required. The UI is B4.
- Workspace over DSH's sandboxed filesystem and `/env` are B3; the UI is B4.
