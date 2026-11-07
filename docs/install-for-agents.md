# Installing and inspecting dsh-arbor

This page is written for an AI agent. It tells you what dsh-arbor is, how to
install it from a clean checkout, how to verify that it works, where each piece
lives, and what is deliberately not finished yet. Follow it in order; every
command is meant to be run as given.

## What you are installing

dsh-arbor runs [arbor](https://github.com/4fuu/arbor) as DeepSeek Harness's
agent driver. A DSH process mounts exactly one arbor host; every DSH user
session is one conversation (one arbor window) of that host; the host's journal
and note store live under `DSH_HOME/arbor/` and survive a DSH restart. Sessions
that do not ask for arbor keep running on DSH's own embedded AgentLoop, in the
same process.

Pins, and do not change them without being asked:

- DeepSeek Harness `dsh-v0.2.2-rc.1`, installed from npm as
  `@deepseek-ai/dsh@0.2.2-rc.1` and its companion packages.
- arbor `@4fu/arbor-*` `2026.1107.0`, from npm.
- This repository's packages are `@4fu/dsh-arbor-*` and are not published;
  installing means checking out this repository.

## Requirements

- Node.js 24.9 or newer (developed on Node 26). The sources are TypeScript run
  directly through Node's type stripping, so there is no build step.
- pnpm 11 or newer (`corepack enable` then `corepack prepare pnpm@11.28.5
  --activate`, or `npm install -g pnpm@11`).
- `DEEPSEEK_API_KEY` in the environment only if you want to run the proofs
  against the real model. The default proof run uses a scripted model and needs
  neither a key nor network access.

## 1. Clone and install

```bash
git clone https://github.com/4fuu/dsh-arbor
cd dsh-arbor
git checkout b3
pnpm install
```

`pnpm install` must finish with exit code 0. If it exits 1 with
`ERR_PNPM_IGNORED_BUILDS`, the dependency install-script policy in
`pnpm-workspace.yaml` is missing or was edited: pnpm 11 refuses to finish while
a package with an install script is neither approved nor explicitly denied.
All six packages this repository pulls in that carry install scripts are
deliberately denied there, each with its reason. Do not "fix" the error by
approving them; the reasons are in that file, and node-pty in particular would
have to compile a native addon on Linux for a code path nothing here uses.

Then verify the tree is self-consistent:

```bash
pnpm check          # tsc --noEmit over every package and proof
pnpm install --frozen-lockfile   # the lockfile matches the manifests
```

## 2. Run the proofs

```bash
pnpm proofs         # all fourteen, in order, against the scripted model
```

Each proof prints one `PASS` or `FAIL` line per assertion and a final
`PROOF n OK`. The suite takes about a minute. A single proof runs on its own:

```bash
pnpm proof:boot        # 00 the boot harness: the shipped profile, one turn
pnpm proof:routing     # 01 per-preset routing with an embedded AgentLoop
pnpm proof:roundtrip   # 02 message -> arbor window -> streamed assistant message
pnpm proof:hidden      # 03 window agents hidden from the session list
pnpm proof:approval    # 04 a tool call needing approval reaches DSH's path
pnpm proof:prompt      # 05 prompt assembly (B0's rule, kept until B2)
pnpm proof:plugins     # 06 common DSH plugins still working
pnpm proof:preset      # 07 the arbor preset in the roster and selectable
pnpm proof:storage     # 08 durable storage, one host, workspace root
pnpm proof:lifetime    # 09 window end, continuation, idle timeout
pnpm proof:resume      # 10 resume of a persisted session after a restart
pnpm proof:sandbox     # 11 arbor's own file tools inside DSH's sandbox
pnpm proof:env         # 12 /env: DSH's skills and MCP servers, read-only
pnpm proof:loop        # 13 the closed loop, across a restart (live-capable)
```

Every proof boots the shipped DSH `headless` profile from npm and composes the
bundle's own patch file as its first overlay, so what a proof boots is what an
installed deployment composes.

Against the real DeepSeek model instead (needs `DEEPSEEK_API_KEY`):

```bash
ARBOR_PROOF_LIVE=1 pnpm proofs          # or a single proof
```

Two known behaviours, neither a failure of the code under test:

- The real model now and then answers a one-word prompt with reasoning only, so
  the assistant output is empty. Proof 1 retries that turn a couple of times.
- A proof process exits as soon as its report is printed. A handle that DSH's
  profile or arbor's host leaves open must not hang the suite; DSH's own smoke
  harness runs each fixture in a subprocess with a timeout for the same reason.
  See `packages/arbor-testkit/src/finish.ts`.

## 3. Drive one live turn yourself, including a restart

To see the whole loop against the real model, write a scratch file inside the
repository (it has to resolve the workspace packages), for example
`proofs/zz-mine.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborHostOf, arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/index.ts'

const NAME = 'my-live-check'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const uninstall = installFailLoud(NAME)
const home = await freshDshHome('my-live')     // sets DSH_HOME
loadEnv(NAME)

// First process: one arbor session, one turn, then dispose (the restart).
const sessionId = brandString(`session-${randomUUID()}`)
let ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [arborPatch, arborOverlay] })
const selection = ctx.agentDefaultModel.currentSelection()
const created = await ctx.agents.create({
  sessionId,
  meta: { cwd: process.cwd(), agentPreset: 'arbor' },
  agentOptions: { ...selection },
  setup: (agentCtx) => { installModelSelection(agentCtx) },
})
created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Say hello in one short sentence.' }], source: { kind: 'user' } }))
await created.agent.whenIdle()
console.log('window after the first turn:', await arborHostOf(ctx).windowFor(sessionId))
await ctx.fiber.dispose()

// Second process, same DSH_HOME: the host continues the window, the session resumes.
ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [arborPatch, arborOverlay] })
const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { ...selection }, setup: (agentCtx) => { installModelSelection(agentCtx) } })
resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Say you are back, in one short sentence.' }], source: { kind: 'user' } }))
await resumed.agent.whenIdle()
await ctx.fiber.dispose()
uninstall()
```

Run it with `node --experimental-strip-types --no-warnings proofs/zz-mine.ts`
and delete it when you are done. What you should see: an assistant message for
each turn on the same session log, the host continuing the session's window
under a new reference after the restart, and no tool call left without a
result.

Proof 13 is the same loop with the assertions already written, and it runs
against the real model with `ARBOR_PROOF_LIVE=1 pnpm proof:loop`. Against the
real model it also shows what the live run proves end to end: the model reads a
DSH skill's `SKILL.md` through arbor's own `read` tool and answers from it, runs
a command in the session's cwd, and calls a DSH MCP tool as a DSH tool.

## 4. Inspect what ran

- `DSH_HOME/arbor/journal.sqlite` is the arbor journal: every window start and
  end, every task, every tool call and result. `DSH_HOME/arbor/notes.sqlite` is
  the note store beside it. Read the journal with `node:sqlite`, which needs no
  extra tool:

  ```js
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(`${process.env.DSH_HOME}/arbor/journal.sqlite`, { readOnly: true })
  console.log(db.prepare('select seq, kind, window, body from events order by seq').all())
  ```

  Two things worth knowing when you read it: a `tool_registration` event with
  `rule: "tool.name_taken"` records that arbor's own tool already held the name
  DSH's tool was offered under, which is the same-name replacement B2 finishes;
  and every event that belongs to a DSH session carries that session as a target
  (`dsh:session:<id>` in `event_targets`), which is how the host knows which
  window belongs to which session after a restart.
- A window's workspace **is** the session's cwd: there is no per-window
  subdirectory and nothing to reclaim, so the host sets no
  `workspaces.retentionMs`. Every file access and every command runs through
  DSH's own `ctx.fs` and `ctx.shell` under the session's sandbox policy, so
  DSH's sandbox mode applies to arbor's `bash`/`read`/`write`/`edit` exactly as
  it does to DSH's own tools of the same names.
- The session log is DSH's own: `assistant/message` events carry the streamed
  reply, `tool/call` and `tool/result` pairs carry every tool call the window
  ran, and `turn/end` closes each turn.
- The composed profile tree is visible with `dsh --profile <name>
  --dump-config` in a real installation, and with the loader entries a proof
  prints (`booted: N loader entries, M active`).

## 5. Where each piece lives

```
packages/
  arbor-host/       the one Arbor host per process: the SQLite journal and note
                    store under DSH_HOME/arbor, the settings, the window
                    lifecycle, and the workspace and environment mounts
  arbor-driver/     the routing AgentRegistry subclass, the AgentFactory, the
                    session agent, the inbox and stream mirrors, the relay that
                    replays the journal onto a resumed session
  arbor-llm/        the arbor AgentBackend: each window's turns run through
                    DSH's ctx.llm and ctx.tools
  arbor-prompt/     the prompt bridge: the <dsh> outside block
  arbor-tools/      the tool bridge: DSH tools as arbor external tools
  arbor-workspace/  the Workspace over DSH's sandbox: the session's cwd, every
                    file access and command through ctx.fs and ctx.shell, and
                    the sandbox_escalate tool
  arbor-env/        /env: arbor's own environment under DSH_HOME/arbor/env, with
                    DSH's skills and MCP servers mounted read-only beside it
  arbor-bundle/     the installable bundle: the patch layer that replaces DSH's
                    agent row and mounts the host, driver and preset
  arbor-preset/     the agent-preset row that puts arbor in DSH's roster
  arbor-testkit/    the boot harness, the memory journal, the scripted model,
                    and the B3 fixtures (a DSH skill row, a stdio MCP server)
patches/            the overlay patch layers a proof applies above the profile
proofs/             one runnable proof per integration point
docs/               b0-findings.md, b3-findings.md, and this page
```

`packages/arbor-bundle` is the installable piece: its `cordis.patch.yml`
disables DSH's base `agent` row, inserts the routing registry, the arbor host
and the arbor driver, and carries the preset row. The proofs load that same
file as their first overlay.

`packages/arbor-bundle` is the installable piece: its `cordis.patch.yml`
disables DSH's base `agent` row, inserts the routing registry, the arbor host
and the arbor driver, and carries the preset row. The proofs load that same
file as their first overlay.

## 6. What works, and what does not

Works, and is covered by a proof:

- Per-preset routing: an `agentPreset: 'arbor'` session runs through the arbor
  driver while an ordinary session in the same process keeps running on the
  embedded official AgentLoop.
- One arbor host per DSH process, with the journal and note store under
  `DSH_HOME/arbor/`, so a session survives a restart; resume replays from the
  journal onto the session log.
- A window's workspace is its session's cwd, and every file access and command
  runs through DSH's own `ctx.fs` and `ctx.shell` under the session's sandbox
  policy — so `read-only` refuses a write and the model reads the refusal with
  the next action, and a `sandbox_escalate` asks the user through DSH's
  approval. The `<workspace>` prompt section names the cwd and the standing
  mode, and only what is true is written.
- `/env` carries DSH's skills (readable by path) and MCP servers (listed, with
  their tools staying DSH tools) beside arbor's own settings, built-in skills
  and the model's own installs.
- A window that ends hands off to a continuation the next turn drives, and a
  window whose idle period passes ends on its own; arbor's own window defaults
  apply.
- Every tool call a window runs leaves one `tool/call` + `tool/result` pair on
  the session log, arbor's own tools included.
- Approvals, DSH's common plugins, and the streaming reply path.

Not finished, and not to be worked around here:

- The prompt bridge is still B0's: it drops DSH's official sections by name
  prefix. B2 replaces it with the per-section decisions in the B2 plan.
- The tool bridge maps DSH's JSON Schema to arbor's parameter specs lossily for
  exotic schemas, and no official same-name tool is replaced yet. (Arbor's own
  tools now run sandboxed; that was B3.)
- The judge is off: a model-based judge cannot run through the DSH backend yet.
- ovnfs is deliberately not offered inside DSH. Its file tools are `node:fs`
  calls on the host, its mount carries no `exec`, and its checkout operations
  spawn the binary directly — all outside `ctx.shell` and `ctx.fs`, so DSH's
  sandbox would not apply to them. The reasoning is at the top of
  `packages/arbor-workspace/src/workspace.ts`.
- The UI is B4.
- The bundle is not published to npm, so an installation is a checkout plus the
  profile wiring below.

## 7. Wiring the bundle into a real DSH installation

A DSH profile is a directory under `$DSH_HOME/profiles/<name>` holding a
`package.json` with a `dsh.profile.bundles` list and its own
`cordis.patch.yml`. DSH composes each listed bundle's patch over the shipped
profile, then the profile's own layer. This is verified end to end against the
published CLI:

```bash
npm install @deepseek-ai/dsh@0.2.2-rc.1     # anywhere; gives you the dsh bin
export DSH_HOME=/tmp/my-dsh-home            # any empty directory
dsh --profile arbor --from-default-profile headless "Reply with the single word: pong"
```

That creates the profile from the shipped `headless` template, boots it and
answers one task with the real model. Now make this repository's packages
resolvable from the profile (they are private and use the pnpm workspace
protocol, so they are linked rather than installed), and list the bundle:

```bash
P="$DSH_HOME/profiles/arbor"
mkdir -p "$P/node_modules/@4fu"
for p in host driver llm prompt tools workspace env bundle preset testkit; do
  ln -sfn "$PWD/packages/arbor-$p" "$P/node_modules/@4fu/dsh-arbor-$p"
done
# add "@4fu/dsh-arbor-bundle" to dsh.profile.bundles in "$P/package.json"
dsh arbor --dump-config        # the composed tree, with the arbor rows in it
```

`dsh arbor "Reply with the single word: pong"` then runs an ordinary session
through the arbor routing registry and the embedded official loop, and
`$DSH_HOME/arbor/` holds `journal.sqlite`, `notes.sqlite` and the `env/`
directory the environment lives in.

The bundle needs the sandbox rows a real installation already has: the base
profile's `bash-sandbox`, `fs-sandbox`, `sandbox`, `sandbox-policy` and
`approval` rows. Without `fs-sandbox` and `bash-sandbox` nothing confines,
`ctx.arborHost.fileToolsSandboxed` is `false`, and arbor's file tools run
unconfined — which the host reports rather than hides.

What the installed CLI cannot do yet: drive an arbor-preset session. The
one-shot runner refuses to adopt any session that runs under a preset —
`session "..." runs under agent preset "arbor", which the one-shot runner does
not compose` — and it has no flag to select one. A session gets
`meta.agentPreset: 'arbor'` from a surface that composes presets: the TUI or
web client (the picker is B4), or the SDK path the proofs use
(`ctx.agents.create` with that meta, then `ctx.agents.resume`). The proofs in
step 2 are the verified path for the arbor preset today.

## 8. The capability the prompt bridge reads

`ctx.arborHost.fileToolsSandboxed` is the one fact B2's prompt bridge needs
before it states the sandbox policy in `<harness>`: it is `true` exactly when
this process mounts a confining filesystem or shell backend, which is what every
window's file access and command runs through. The B2 plan's `sandbox:policy`
row is to be written only when this is true — a line that claims confinement the
file tools do not have is a lie the model would act on.

Read it as:

```ts
const host = ctx.get('arborHost') as { fileToolsSandboxed: boolean }
if (!host.fileToolsSandboxed) return ''   // do not write the sandbox line
```

## 9. If something fails

- `ERR_PNPM_IGNORED_BUILDS` on install: see step 1.
- The type checker runs out of memory: the driver pins zod to `~4.4.3` because
  zod 4.6's type graph takes the whole program past a 2 GB heap. Keep the pin.
- A proof reports `FAIL`: read the detail on that line first; each assertion
  prints what it saw.
- A live proof fails on the model listing: `DEEPSEEK_API_KEY` is missing or
  wrong, or the network is unavailable. Use the scripted default instead.
- A proof reports that a write was refused when you expected it to succeed: the
  profile's sandbox mode is `workspace-write` unless `DSH_PERMISSION_MODE` says
  otherwise, and `workspace-write` allows only the session's cwd. Check the
  session's `cwd` and the mode the `<workspace>` section names.
- Anything else: the findings in `docs/b0-findings.md` and `docs/b3-findings.md`
  record where each integration point lives in DSH's own sources.
