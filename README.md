# dsh-arbor — B0 spike

A spike that proves, against real DeepSeek Harness code, the integration points
for running [arbor](https://github.com/4fuu/arbor) (`@4fu/arbor-*` 2026.1106.1)
as DSH's agent driver. Every claim below is backed by a runnable proof in
`proofs/` that boots the shipped DSH `headless` profile from npm packages and
drives real sessions through it.

- DSH is pinned to tag `dsh-v0.2.2-rc.1` (commit `66491b05e3` of
  deepseek-ai/deepseek-harness); the spike installs the published
  `@deepseek-ai/dsh@0.2.2-rc.1` packages, so no monorepo build is needed.
- arbor is pinned to `2026.1106.1`.
- Node 24+ (developed on Node 26; the spike runs TypeScript sources directly
  through Node's type stripping, so the plugin code is erasable-syntax only).

## Run the proofs

```bash
pnpm install
pnpm check        # tsc --noEmit over every package and proof
pnpm proofs       # all seven proofs in order
```

Each proof can also run alone, and prints one `PASS`/`FAIL` line per assertion
plus a final `PROOF n OK`:

```bash
pnpm proof:boot        # 00: the boot harness, real-model turn, no arbor code
pnpm proof:routing     # 01: per-preset routing with an embedded AgentLoop
pnpm proof:roundtrip   # 02: message -> arbor window -> assistant message, streamed
pnpm proof:hidden      # 03: window agents hidden from the session list
pnpm proof:approval    # 04: a tool call needing approval reaches DSH's approval path
pnpm proof:prompt      # 05: official prompt sections dropped, third party in <dsh>
pnpm proof:plugins     # 06: common DSH plugins still working
```

Proofs 0, 1 and 2 talk to the real DeepSeek model when `DEEPSEEK_API_KEY` is in
the environment (the headless profile reads the key from the launch
environment). Proof 2's scripted path needs no key; run its live path with:

```bash
ARBOR_PROOF_LIVE=1 pnpm proof:roundtrip
```

## What each proof shows

| Proof | Integration point | Result |
| --- | --- | --- |
| 00 | Boot harness | shipped `headless` profile boots from npm; one real-model turn runs |
| 01 | Per-preset routing | base `agent` row replaced by a routing registry; ordinary sessions keep running on the embedded official AgentLoop, `agentPreset: 'arbor'` sessions run through the arbor driver, both in one process |
| 02 | Round trip + streaming | a user message reaches an arbor window; the window's answer comes back as `assistant/message` with ordered `agent/assistant-stream` frames; a tool call runs through arbor's tool path into `ctx.tools.execute` |
| 03 | Window agents hidden | each window is registered with `meta.origin: 'subagent'`, owned by the user session's agent; the shipped sidebar rule leaves it out |
| 04 | Approvals | an `ask` tool call reaches `ctx.tools.execute` with the user session's agent, the ask/decide audit pair lands inside its open turn, and grant / reject / fail-closed all behave |
| 05 | Prompt assembly | 18 official DSH sections dropped with no survivor; the third-party section arrives inside the arbor `<dsh>` outside block |
| 06 | Common plugins | seven common plugin rows active, their sections registered, `todo_write` runs on the arbor path and on the embedded-loop path |

Findings, the exact DSH source locations each one rests on, what arbor's core
is still missing, and the recommended B1 module layout:
[docs/b0-findings.md](docs/b0-findings.md).

## Layout

```
patches/            overlay patch layers applied above the shipped profile
  control.patch.yml   the shipped profile with its one-shot runner rows disabled
  arbor.patch.yml     control + the routing registry, driver and journal rows
  scripted.patch.yml  the scripted provider route and test tools (no network)
  prompt.patch.yml    a third-party prompt section, as a plugin would register
packages/
  arbor-agent/       the routing AgentRegistry subclass and the arbor driver
  arbor-llm/         the arbor AgentBackend that runs windows through ctx.llm
  arbor-prompt/      the prompt bridge: <dsh> outside block, official sections dropped
  arbor-tools/       the tool bridge: DSH tools as arbor external tools
  arbor-testkit/     the boot harness, the in-memory journal, the scripted model
proofs/              one runnable proof per integration point
```

The overlay pattern is the one DSH's own tests use
(`packages/test-support/loader-smoke/tests/fixtures/production-profile.ts`,
`packages/experimental/subagent-oar/tests/fixtures/loader/`), anchored on the
npm-published `@deepseek-ai/dsh` installation instead of `apps/cli`.

## B0 scope

Per the decided plan, arbor sessions run without compaction, goals,
agentTeams, retry or fork. `resume` of a persisted arbor session fails with a
descriptive error: rebuilding the arbor window from its journal with a relay
cursor is B1 work. See [docs/b0-findings.md](docs/b0-findings.md) for the full
gap list.
