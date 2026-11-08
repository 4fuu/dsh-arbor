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
- arbor `@4fu/arbor-*` `2026.1107.1`, from npm.
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
git checkout b3d
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
pnpm proofs         # all twenty-two, in order, against the scripted model
```

Each proof prints one `PASS` or `FAIL` line per assertion and a final
`PROOF n OK`. The suite takes about a minute. A single proof runs on its own:

```bash
pnpm proof:boot        # 00 the boot harness: the shipped profile, one turn
pnpm proof:routing     # 01 per-preset routing with an embedded AgentLoop
pnpm proof:roundtrip   # 02 message -> arbor window -> streamed assistant message
pnpm proof:hidden      # 03 window agents hidden from the session list
pnpm proof:approval    # 04 a tool call needing approval reaches DSH's path
pnpm proof:prompt      # 05 prompt assembly: drops decided, third party in <dsh>
pnpm proof:plugins     # 06 common DSH plugins still working
pnpm proof:preset      # 07 the arbor preset in the roster and selectable
pnpm proof:storage     # 08 durable storage, one host, workspace root
pnpm proof:lifetime    # 09 window end, continuation, idle timeout
pnpm proof:resume      # 10 resume of a persisted session after a restart
pnpm proof:sandbox     # 11 arbor's own workspace over the shared folder, no sandbox
pnpm proof:harness     # 11 the rendered system prompts, the deltas, the tool sets
pnpm proof:env         # 12 /env: DSH's skills and MCP servers, read-only
pnpm proof:sections    # 12 the decision table against the pinned DSH
pnpm proof:loop        # 13 the closed loop, across a restart (live-capable)
pnpm proof:send-links  # 13 what <harness> promises about send and @path
pnpm proof:windows     # 14 two windows on one project do not collide
pnpm proof:preset-selection   # 15 picking Arbor in a composer runs arbor
pnpm proof:external-project   # 16 add-workspace becomes a pointer for that session
pnpm proof:project-section    # 17 the session's project is named once in <workspace>
pnpm proof:picker-pin         # 18 the picker filter is pinned to the shipped plugin
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
- `ARBOR_PROOF_LIVE=1` runs every proof against the profile's own default model.
  Only proof 13 changes what it asserts under it (which tools the live model
  reaches for is its own choice); the others keep the scripted path and need no
  key.
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
a command in the arbor shared folder, and calls a DSH MCP tool as a DSH tool.

### 3a. The web profile, and ovnfs for real

The proofs boot the `headless` profile. The browser surface is the `web`
profile, and a scratch file inside the repository starts it the same way:

```ts
const ctx = await bootArborProfile({
  binName: 'arbor-web-shot',
  profile: 'web',
  overlayPaths: [arborPatch, '/path/to/patches/arbor.patch.yml'],
  prepare: (root) => {
    root.provide('webStartup', { openBrowser: false, host: '127.0.0.1', port: 3080, trustedHosts: ['127.0.0.1'] })
  },
})
```

It prints `dsh web: http://127.0.0.1:3080/?token=…`. Open that in a browser and
the hero composer is there: the workspace chip, the preset chip, and (for a
Standard composer) the sandbox access-mode switch. A session created through the
controller's own calls — `ctx.agents.create` with no preset, then
`agentPresets.select(agent, 'arbor')` — is the path the hero chip takes, and it
is what proof 15 drives.

**ovnfs is chosen only when its binary is on `PATH`.** `openWorkspace` runs
`execFile('ovnfs', …)` and falls back to the plain-directory workspace when the
binary is missing or its daemon will not start, so a checkout and apply cannot
be exercised without it. The proofs therefore stage a stand-in
(`useOvnfsStub`). To run the real one, mirror arbor's own CI `ovnfs` job:

```bash
sudo apt-get install -y fuse3
base=https://github.com/stencil-hq/ovnfs/releases/download/v0.1.1
curl -fsSL -O "$base/ovnfs_0.1.1_linux_amd64.tar.gz" -O "$base/ovnfs_0.1.1_checksums.txt"
grep ' ovnfs_0.1.1_linux_amd64.tar.gz$' ovnfs_0.1.1_checksums.txt | sha256sum -c -
mkdir -p ovnfs-bin && tar -xzf ovnfs_0.1.1_linux_amd64.tar.gz -C ovnfs-bin ovnfs
export PATH="$PWD/ovnfs-bin:$PATH"
ovnfs version          # ovnfs v0.1.1
```

Verified on branch `b3d` in an orb: `/dev/fuse` exists, `fuse3` 3.14.0 is
installed, the daemon starts and mounts, and a checkout created with
`ctl new` is readable and writable through the mount with `ctl diff` and
`ctl apply` merging back into the source. In the web profile with that binary on
`PATH` the host reports `workspaceBackend = ovnfs` and
`mount` shows `fuse.ovnfs` on `<DSH_HOME>/arbor/ovnfs/checkouts` — the mount is
the checkouts directory, not the shared folder, so projects can still be seeded
into `<DSH_HOME>/arbor/shared` after boot. Ubuntu's `fusermount3` AppArmor
profile only allows mounts below `$HOME`, `/mnt`, `/media` and `/tmp`, so keep
`TMPDIR` (and therefore `DSH_HOME`) under one of those on a stock Ubuntu runner;
the orb has no such restriction.

One live turn against the real model on that setup: the model's first tool call
listed the picked project's files by absolute path, read its two files and
answered from them, using arbor's own `bash`/`read`/`send`.

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
- A window's workspace is arbor's own, over the arbor shared folder under
  `DSH_HOME/arbor/shared`: ovnfs when its binary is found and its daemon starts
  (a copy-on-write checkout per window, opened with `workspace.checkout`, merged
  back with `workspace.apply`), the plain-directory workspace otherwise. For
  arbor sessions there is no DSH sandbox — arbor's file tools run on the host the
  way they do in standalone arbor, and arbor's own secret scrub is the only
  protection on what reaches the model. The proofs stage an ovnfs stand-in on
  PATH (`useOvnfsStub`); section 3a installs the real binary, which is what
  makes the host report the `ovnfs` backend. An
  ordinary session on the embedded AgentLoop is untouched: its file tools still
  run through DSH's `ctx.fs` and `ctx.shell` under its own sandbox policy.
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
  arbor-prompt/     the prompt bridge: the <dsh> data block, the trusted
                    <harness> section, and the per-section decision table
  arbor-tools/      the tool bridge: DSH tools as arbor external tools with
                    DSH's own JSON Schema, the same-name tools restricted away
  arbor-workspace/  arbor's own workspace over the shared folder: ovnfs, or the
                    plain directory, with no DSH sandbox, plus the bridge that
                    makes the shared folder's projects the DSH project list
  arbor-env/        /env: arbor's own environment under DSH_HOME/arbor/env, with
                    DSH's skills and MCP servers mounted read-only beside it
  arbor-bundle/     the installable bundle: the patch layer that replaces DSH's
                    agent row and mounts the host, driver, preset and the two
                    client packages
  arbor-ui/         the browser package that hides the sandbox access-mode
                    switch for an arbor composer
  arbor-ui-workspace/
                    the browser package that filters DSH's hero project picker
                    per preset
  arbor-preset/     the agent-preset row that puts arbor in DSH's roster
  arbor-testkit/    the boot harness, the memory journal, the scripted model,
                    and the B3 fixtures (a DSH skill row, a stdio MCP server)
patches/            the overlay patch layers a proof applies above the profile
proofs/             one runnable proof per integration point
docs/               b0-findings.md, b3-findings.md, b3b-projects-and-sandbox.md,
                    and this page
```

`packages/arbor-bundle` is the installable piece: its `cordis.patch.yml`
disables DSH's base `agent` row, inserts the routing registry, the arbor host
and the arbor driver, and carries the preset row and the two `dsh.client`
packages (`@4fu/dsh-arbor-ui`, `@4fu/dsh-arbor-ui-workspace`). The proofs load
that same file as their first overlay.

## 6. What works, and what does not

Works, and is covered by a proof:

- Per-preset routing: an `agentPreset: 'arbor'` session runs through the arbor
  driver while an ordinary session in the same process keeps running on the
  embedded official AgentLoop. A blank session that selects arbor afterwards is
  re-routed onto the same driver, keeping its identity and its log, and a
  selection after the first turn is refused with a visible reason.
- One arbor host per DSH process, with the journal and note store under
  `DSH_HOME/arbor/`, so a session survives a restart; resume replays from the
  journal onto the session log.
- A window's workspace is arbor's own over the shared folder: ovnfs checkouts a
  window opens, works in and applies back, or the plain-directory fallback. There
  is no DSH sandbox for arbor sessions — arbor's file tools run on the host, and
  arbor's own secret scrub is the only protection. Tool approval is kept: a call
  that needs approval still routes through DSH's approval on the user session's
  agent. The `<workspace>` prompt section is arbor's own (ovnfs or directory
  method), with no sandbox line, and it names the session's project once —
  `当前项目 <name>：<path>` plus how the window reaches it.
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

- **B3b, B3c and B3d have landed** (see `docs/b3b-projects-and-sandbox.md`):
  arbor owns project management for arbor sessions and DSH's sandbox is gone for
  them. The workspace is arbor's own over the shared folder (ovnfs, with the
  plain directory as the fallback) and per-window checkouts;
  `DshSandboxSeam` / `DshSandboxWorkspace` / `sandbox_escalate` are removed, and
  the shared folder's projects are the DSH project list. Ordinary sessions keep
  their sandbox and cwd. Branch `b3d` adds the project line inside
  `<workspace>` and the per-preset picker filter.
- The judge is off: a model-based judge cannot run through the DSH backend yet.
- ovnfs is offered again for arbor sessions. B3 kept it out because its host-side
  `node:fs`, `spawn('/bin/sh')` and daemon subprocess would be a hole through
  DSH's sandbox; with the sandbox gone for arbor sessions that reasoning no
  longer holds, so the workspace is arbor's own, chosen by arbor-core's
  `openWorkspace` (ovnfs when the binary is found, the plain directory
  otherwise). Verified with the real v0.1.1 binary in the web profile on branch
  `b3d`: the host reports the `ovnfs` backend and mounts
  `<DSH_HOME>/arbor/ovnfs/checkouts` as `fuse.ovnfs`. See section 3a.
- The composer's sandbox access-mode switch is gone for arbor sessions, in the
  browser, through `@4fu/dsh-arbor-ui`'s own `dsh.client` package: it shadows the
  `conversation.input.permission` `single` slot one priority below the shipped
  `PermissionSelect`, reusing that component, inject face and locale, and renders
  nothing when the preset the composer is about to run is `arbor`. The switch
  disappears the moment Arbor is picked in the hero and returns when Standard is
  picked again; an ordinary composer keeps the control byte-for-byte. See the UI
  section of `docs/b3b-projects-and-sandbox.md`.
- **"Add workspace…" records a pointer for the arbor session that asked, with no
  new verb and no client change.** The client's add-workspace action calls the
  `workspace/create` remote verb, which is the one caller of
  `WorkspaceRegistry.create` besides the project bridge's own sync, so the bridge
  hooks `create` and remembers every directory registered outside the shared
  folder as one the user added; the driver then asks at the two moments a session
  becomes an arbor session whether the directory it names was added, and records
  the pointer only then. Pointers are per session and render inside arbor's
  `<workspace>`, answered per window. Proof 16 covers the chain; proof 8 covers
  recording, listing, dropping and the mid-window delta.
- **Picking Arbor in the web hero runs arbor.** DSH's preset registry commits the
  hero chip's staged pick as an `agent-preset/selected` event on the session log;
  the driver observes that event, ends the embedded agent with the handle its
  creation returned, and opens the same session id under arbor, so the session
  keeps its identity and its log and its next turn runs arbor. A selection after
  the first turn is refused by DSH with a visible reason ("This session has
  already started"), and the driver guards on the turn boundary as well: nothing
  silently keeps the driver it began with. The other direction is followed too —
  a blank arbor session that selects another preset goes back to the embedded
  loop — because DSH re-selects the default preset whenever the picker reuses a
  blank session. Proof 15 covers all of it.
- **The project picker is filtered per preset, in the browser.**
  `@4fu/dsh-arbor-ui-workspace` is a `dsh.client` package that wraps
  `ctx.slots.register` for the one registration that matters: the shipped
  `@deepseek-ai/dsh-client-ui-workspace`'s `conversation.hero.workspace` seat
  arrives through the wrapper, keeps its options, children table, inject face
  and locale, and only its component is replaced by one that filters
  `useWorkspaces`. An arbor composer lists every workspace and marks the
  directories outside the shared folder `（外部）`; any other composer lists
  nothing from arbor's tree. The shipped row stays **enabled**: the host serves
  the client module graph from the composed plugin tree, so a disabled row's
  package is not in the graph and a `dsh.client.inject` dependency of the
  shipped plugin cannot arrive, and re-running the shipped `apply` with the row
  enabled throws `service "uiWorkspace" has been registered`. The registration
  shape is pinned by proof 18, which fails when the shipped bundle, the pick
  flow's state selection, the shipped service list or the pinned DSH version
  moves. Two limits are known and documented in
  `docs/b3b-projects-and-sandbox.md`: the arbor/non-arbor rule is a path
  convention (`arbor/shared` segments), because a client package has no channel
  to the host's answer, and the sidebar's own workspace browser
  (`sidebar.workspaces`) is not filtered — it is not per-session, so there is no
  preset to key a filter on.
- **The session's project is named once in `<workspace>`.** The section carries
  `当前项目 <name>：<path>` plus the reach line the workspace implementation's
  own: ovnfs opens a checkout of the project subfolder, the plain-directory
  workspace reaches it by absolute path. The project is read from the session's
  *current* directory (DSH's `workingDirectory` projection), a re-routed session
  and one created under arbor resolve it the same way, a restart brings it back,
  and a project that moves before the first turn reaches a running window as a
  delta of only the changed lines. Proof 17 covers all of it.
- **Two web-hero behaviours that are not finished.** (1) Picking Arbor in the
  hero runs arbor — proof 15 and a live run confirm the driver follows — but the
  hero's own composer goes disabled at that moment and stays disabled: DSH's
  `InputBar` computes `live = input !== undefined && keyboard !== undefined &&
  inputActions !== undefined` (`@deepseek-ai/dsh-client-ui-conversation`,
  `lib/client.js`), and the re-route ends the embedded agent whose session scope
  held those services. Choosing a project in the picker, or opening the session
  from the sidebar tree, re-mounts the composer and it works; a fresh "New
  Session" also works but starts on the default preset. (2) Adding a workspace
  from the hero re-uses the blank session, and DSH's `reuseLive` re-selects the
  deployment default preset, so an Arbor pick made a moment earlier is followed
  back to the embedded loop. Both are honest — the label always names the driver
  actually running — and both are recorded in
  `docs/b3b-projects-and-sandbox.md`.
- The rest of the UI is B4.
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

The bundle keeps the rows a real installation already has: the base profile's
`bash-sandbox`, `fs-sandbox`, `sandbox`, `sandbox-policy` and `approval` rows.
They confine the ordinary sessions that run on the embedded AgentLoop. Arbor
sessions do not use them — arbor's file tools run on the host — so nothing about
an arbor session depends on whether they are mounted; B3b removed that
dependency together with the sandbox.

What the installed CLI cannot do yet: drive an arbor-preset session. The
one-shot runner refuses to adopt any session that runs under a preset —
`session "..." runs under agent preset "arbor", which the one-shot runner does
not compose` — and it has no flag to select one. A session reaches arbor from a
surface that composes presets: the web client's hero chip (pick Arbor on a blank
session and the driver re-routes it, which is what proof 15 drives), the SDK path
the proofs use (`ctx.agents.create` with `meta.agentPreset: 'arbor'`, then
`ctx.agents.resume`), or the TUI. The proofs in step 2 are the verified path for
the arbor preset today.

## 8. The prompt bridge: `<harness>`, `<dsh>`, and the decision table

Two sections the bridge owns, and they are different in kind:

- **`<harness>`** is trusted framework prompt, written by dsh-arbor itself and
  not marked as data. It carries what is still true of DSH for an arbor window:
  that the window runs inside DeepSeek Harness and the user only sees what
  `send` writes, the approval policy in force, how to write image and file links
  into `send` so DSH renders them, how `@path` references arrive, the
  deployment's plan-mode guidance while plan mode is active, and the usage text
  of the DSH tools that are actually exposed. Its fixed lines come from
  `packages/arbor-prompt/src/text.ts`, in Chinese like arbor's own table.
- **`<dsh>`** is a data block. Third-party plugin sections and the instructions
  an MCP server hands down go here, marked as data, with arbor's rules winning
  on conflict. No official section goes here. It is absent when there is
  nothing from outside: arbor's `data` block renders its `<data>` wrapper and
  its data mark even with an empty field, so a section registered outside would
  say "this is data" about nothing — and DSH always registers
  `mcp-resource-servers`, which the table decides outside, so the default case
  is exactly that trap. The precedence rule in `<agent>` follows the same flag,
  so it is stated only when there is material it governs.

Everything official is decided one by one in
`packages/arbor-prompt/src/sections.ts`, and the table is pinned to
`dsh-v0.2.2-rc.1`: `proofs/12-official-sections.ts` fails when the pinned DSH
registers an official section name the table does not decide, so a DSH upgrade
cannot let a new section in silently.

Three decisions from revision 2 of the table, which is what this branch ships:

- `sandbox:policy` is dropped. An arbor session does not run through DSH's
  sandbox, so `<harness>` writes no sandbox line and the host reports no
  `fileToolsSandboxed` any more.
- `working-directory:current` is dropped, and it is dropped from the
  runtime-context snapshot too, so the paths have exactly one home: arbor's own
  `<workspace>` section.
- `@path` references resolve from arbor's workspace root, which is arbor's shared
  folder for an arbor session — the session's cwd is the shared folder, and a
  relative `read` resolves against it (ovnfs's mount path).

Two more, from the review of the rendered prompts:

- `working_directory` and `skill` are restricted for arbor sessions.
  `working_directory` is DSH's project management, which arbor owns: the paths
  are arbor's `<workspace>` section's, and a `cd` would move the ground the
  section describes. A UI switch still lands as a `working-directory/change`
  event, but an arbor session is not bound to one cwd — its window works in the
  shared folder and its checkouts, so the event moves the session's cwd display
  and nothing a window does. `skill` is `read` of the `SKILL.md` that `<env>`
  already names, and arbor's own `read` reaches it. `read_image` stays: it
  returns the image itself, which arbor's text-only `read` cannot.
- The host's arbor settings carry no `generalRules` any more, so arbor's own
  seven rules render in Chinese instead of B0's three English ones — two of
  which restated arbor's own and one of which claimed one DSH session is one
  arbor window, which arbor's own window model contradicts.

The dynamic parts — the approval policy and plan mode — reach a running window
as a `prompt_delta` carrying only the changed lines, and a delta never starts a
turn: it goes in at the next step boundary and is read by the turn that follows.

## 9. If something fails

- `ERR_PNPM_IGNORED_BUILDS` on install: see step 1.
- The type checker runs out of memory: the driver pins zod to `~4.4.3` because
  zod 4.6's type graph takes the whole program past a 2 GB heap. Keep the pin.
- A proof reports `FAIL`: read the detail on that line first; each assertion
  prints what it saw.
- A live proof fails on the model listing: `DEEPSEEK_API_KEY` is missing or
  wrong, or the network is unavailable. Use the scripted default instead.
- A proof reports that a write was refused when you expected it to succeed: an
  arbor session has no DSH sandbox, so arbor's own file tools write on the host
  and are not refused by a sandbox mode. If you are testing an *ordinary*
  session, its sandbox mode is `workspace-write` unless `DSH_PERMISSION_MODE`
  says otherwise, and `workspace-write` allows only the session's cwd.
- Anything else: the findings in `docs/b0-findings.md` and `docs/b3-findings.md`
  record where each integration point lives in DSH's own sources.
