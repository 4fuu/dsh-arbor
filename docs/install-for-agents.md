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
- arbor `@4fu/arbor-*` `2026.1109.0`, from npm. The arbor error package
  `@4fu/arbor-errors` is still `2026.1107.0`; it is the only published version.
- This repository's packages are `@4fu/dsh-arbor-*` and are not published;
  installing means checking out this repository.

## Requirements

- Node.js 24.9 or newer (developed on Node 26). The sources are TypeScript run
  directly through Node's type stripping, so there is no build step.
- pnpm 11.28.5. The repository's `.agents/setup` installs exactly that version
  with npm into `~/.local/bin`; corepack's pnpm shim does not run under Node 26.
  To do it by hand: `npm install -g pnpm@11.28.5`.
- `DEEPSEEK_API_KEY` in the environment only if you want to run the proofs
  against the real model. The default proof run uses a scripted model and needs
  neither a key nor network access.

## 1. Clone and install

```bash
git clone https://github.com/4fuu/dsh-arbor
cd dsh-arbor
git checkout b4
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
pnpm proofs         # all twenty-eight, in order, against the scripted model
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
pnpm proof:hero-create-routing # 19 the hero pick creates the session as arbor
pnpm proof:ovnfs-project       # 20 the ovnfs project line: where paths start, read in place
pnpm proof:arbor-workspace-membership  # 21 the session belongs to the workspace the user picked
pnpm proof:reload-preset                # 22 a cold client restores a blank under its recorded preset
pnpm proof:facts                        # 23 the panel facts and live stream are arbor's own
pnpm proof:host-facts                   # 24 the whole host view names only labeled sessions
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
Standard composer) the sandbox access-mode switch. Picking Arbor on the hero
mints a session created under the preset (`session/create` with `agentPreset`,
no `sessionId`), which is what proof 19 drives; the older path —
`ctx.agents.create` with no preset, then `agentPresets.select(agent, 'arbor')`
— is what an SDK or a remote `agent-preset/select` still takes, and it is what
proof 15 drives.

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

### 3b. The arbor page in the web client

`@4fu/dsh-arbor-ui` adds one permanent entry to DSH's left navigation, beside
Plugins and Automation tasks, and one root-scoped page behind it. The entry is a
`sidebar.panellist` row with `id` `arbor`; the page is a registration in the
root-scoped `main` slot with `key` `arbor`, so the sidebar selects it by the same
id. This is the same pair the official plugin manager registers
(`@deepseek-ai/dsh-client-ui-plugin-manager`, `lib/client.js`, the
`sidebar.panellist` registration around line 7820 and the `main` registration
around line 7749) and the same seam the shipped Automation-tasks row uses
(`@deepseek-ai/dsh-client-ui-schedule`). The official "便签" example is not
shipped in the npm package tree; the two shipped packages are the reference for
the seam. The sidebar registers the page component itself as the row's icon and
passes `label: () => t('panelLabel')`, so DSH owns the row's accessible name and
the page keeps its own locale namespace.

The page is the whole-host picture. It reads three exact Fetch routes registered
by `@4fu/dsh-arbor-facts` through `ctx.connection.fetch.register`
(`@deepseek-ai/dsh-client-connection`, `HostConnectionFetch`), the least
invasive route from a `dsh.client` bundle to a host service:

- `GET /api/arbor/host` — every labeled arbor session, its window chain, the
  board, the active notes, `/env`, the schedules and arbor's settings, then each
  rebuild and each live `Arbor.stream(window, …)` delta as NDJSON;
- `GET /api/arbor/facts?sessionId=…` — the same read for one session, used by
  that session's tab;
- `GET /api/arbor/search?q=…` — arbor's own `Arbor.search`, over its journal,
  notes and board.

A session is an arbor session because arbor says so: the driver sets
`TaskInput.label` to the DSH session id, and arbor carries that label onto the
window, its continuations, the `window_start` event and the per-window prompt
section. The host view reads the labels, not a `windowStart` map kept in the
browser. Expanding a session opens its own tab with only that session's current
state: the live window and its status, the continuation chain with end reasons
and handoffs, the project and external pointers from `<workspace>`, and what is
running now. An ordinary DSH session has no such tab; the permanent left entry
still opens the host view, which simply does not list it.

The page leads a session card with DSH's own session title — the text the
sidebar shows from the latest `session/title` event — and keeps the project and
the window-chain summary as secondary lines. The UI text is Chinese with an
English dictionary registered in the `arborUi` locale namespace, so DSH's
language switch switches the page.

One display exception is deliberate. Arbor learns that a run is active from its
usage event, which arrives after the first text, so a window can be `idle` in
`Arbor.live()` while `Arbor.stream` is already delivering deltas. The card and
the hero show that window as running only while a delta is current; the
underlying arbor state is never rewritten. When the deltas stop, the page falls
back to the host's own state.

The shape is editorial rather than a dashboard. The date line and one muted
sentence say the state; only the window refs and counts in that sentence take
full contrast and the numeric role. The surface below is a measured skyline
scatter, deliberately ragged rather than a grid. Each card kind has a width:
a live window about 560 px, a chain about 150 px per node plus padding, a
session about 360 px, the environment about 320 px, the board about 280 px,
a note 240-280 px (longer text gets the wider end), and a schedule about 240 px.
The widths scale with the surface, but a chain is never made narrower than its
nodes need. Height is always the card's own content; nothing is stretched to a
neighbour.

Cards are placed in importance order — live windows, chain, session, board,
notes, environment, schedules — at the lowest skyline point where the width
fits, ties to the left, with a 20 px gutter. Rows do not line up and the right
edge stays ragged. The packer is measured: every card height comes from the
rendered card, so a growing output pushes only the cards below it. Holes are
allowed, but the largest enclosed hole is measured and is smaller than the
smallest card on the page; only the bottom edge may stay open, and a bottom
notch is allowed only when no card can fit it. The union of card boxes has no
overlap. The dock is sticky and floats over the bottom row while the page is
being scrolled; the scroll content reserves the dock's measured height plus its
18 px bottom offset, so at the end of the scroll no card is under it. Below
about 640 px the same packer becomes one column. The
chain card is wide enough for every node (measured by `scrollWidth` against
`clientWidth`) and its nodes never overflow.

Notes and board cards are paper: a tilt of -1.6° to +1.6° and a 0-12 px vertical
offset derived from a hash of the card's ref, so a reload restores the same
arrangement. The window, chain, session and environment cards stay straight.
Hovering a paper card straightens it and lifts it by 5 px with a 150 ms
transform and shadow transition, with no layout shift; `prefers-reduced-motion`
removes the tilt, the transition and the lift. A board card is an index card;
a note keeps its paper tint and soft shadow.

A live window's output is rendered as Markdown and clamped with `展开全文`
(expanding removes the clamp); a single newline is a soft break, joining lines
with a space only between Latin words and with no space between CJK characters,
while blank lines remain paragraphs and list or heading structure is preserved.
A chain's nodes carry a ref, a state and a handoff mark; board and note cards
put content first and metadata in a small footer. A floating bottom dock filters 全部 / 窗口 / 看板 / 笔记 / 环境 / 日程;
search and settings are the two top-right icons and open sheets. The empty
state is one sentence and a hint, with no dock and no zero-valued cards. All
colours, borders and elevation come from `--dsw-*` tokens, so DSH's light and
dark appearance both work without the page choosing a theme.

What the page shows comes from arbor, not from a browser guess:

- windows and the chain: `ArborHostService.windowChainOf`, `Arbor.live()` and
  the journal's `window_start`, `window_end` and `board_line` events;
- a handoff's four parts: the model's `end` tool call in the journal;
- workspace: the workspace implementation's project, pointers, checkouts,
  keeps and open work;
- notes: `NoteStore.snapshot()`, the active set frozen by its epoch;
- `/env`: `Environment.list()` plus the journal's `service_state` events;
- schedules: `Arbor.schedules()`;
- settings: `Environment.settings()`, falling back to the deployment's seed.

The `send` executor writes a delivered send's assistant message after the
step's tool results, not between a tool call and its result: DSH rejects a log
whose `tool_use` is not followed by `tool_result`, and the driver flushes the
executor at the end of each step. A window's live output is the stream, not a
reconstruction from that message.

The page also says where DSH's own settings card does not apply: the Agent-loop
plugin page configures ordinary sessions, while an arbor window runs under the
model tiers and window limits arbor reports. Proof 23 covers the per-session
facts and the live stream; proof 24 covers the host view, the session title, the
label and the absence of an ordinary session.

### 3c. Typography contract

Every text node on the arbor page and on a session tab carries exactly one
`data-arbor-text` role:

- `body` — reading text: model output, note bodies, board lines, card body and
  secondary lines, chain handoff summaries, empty-state hints and Settings
  prose. It uses `--arbor-font-body`.
- `display` — display text: the hero sentence, card titles, tab labels, dock
  pills, card kickers, status chips and the empty-state heading. It uses
  `--arbor-font-display`.
- `numeric` — window, note and task refs, counts, token figures, dates and
  times. It uses `--arbor-font-numeric` with `font-variant-numeric:
  tabular-nums`.
- `code` — paths, ids, and inline or block code inside Markdown. It uses
  `--arbor-font-code`.

The four properties are defined on the Arbor root and default to DSH's own
tokens: body, display and numeric use `--dsw-font-family`; code uses
`--ds-font-family-code`. With no font plugin installed the page therefore uses
DSH's fonts exactly.

The root of the overall page and the root of every session tab carry
`data-arbor-page`. Each `data-arbor-text` node takes its `font-family` from its
own role property (`var(--arbor-font-body)`, `var(--arbor-font-display)`,
`var(--arbor-font-numeric)` or `var(--arbor-font-code)`), rather than only
inheriting the root's face, because a font plugin sets the property on the role
nodes itself. A font plugin may target `[data-arbor-page]` and
`[data-arbor-text]` and override only these four custom properties; it must not
depend on class names or page structure. No font files are vendored by this
package.

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
  arbor-facts/      the host read face behind the arbor page: session and
                    whole-host facts, search, and the exact Fetch routes
  arbor-ui/         the left-sidebar arbor page, its session tabs, its Chinese
                    and English copy, and the sandbox access-mode gate for an
                    arbor composer
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
- The arbor page in the web client: one permanent left entry, the whole-host
  page across sessions, and one tab per arbor session with its live window,
  chain, handoff, project, external pointers and running work. Every value is
  read from arbor's own API and journal; the page updates from arbor's own
  append/note/environment hooks and `Arbor.stream(window, …)`. Ordinary
  sessions get no arbor tab and keep their composer, sandbox and header
  unchanged. The page's session card and tab lead with DSH's session title.
- Arbor 2026.1109.0's window label, `Delivery.role` (`context` versus `input`)
  and `send.unowned` refusal are in use: the facts page finds a session's
  windows by label, and a send from a window that does not own the target is
  refused with arbor's own rule instead of being delivered.
- Approvals, DSH's common plugins, and the streaming reply path.

Not finished, and not to be worked around here:

- **B3b, B3c, B3d, b3e, b3f, b3g and b3h have landed** (see
  `docs/b3b-projects-and-sandbox.md`):
  arbor owns project management for arbor sessions and DSH's sandbox is gone for
  them. The workspace is arbor's own over the shared folder (ovnfs, with the
  plain directory as the fallback) and per-window checkouts;
  `DshSandboxSeam` / `DshSandboxWorkspace` / `sandbox_escalate` are removed, and
  the shared folder's projects are the DSH project list. Ordinary sessions keep
  their sandbox and cwd. Branch `b3d` adds the project line inside
  `<workspace>` and the per-preset picker filter; branch `b3e` carries the Arbor
  pick across a workspace switch; branch `b3f` mints the session under the picked
  preset instead of re-routing a live blank, and carries the pick into a
  workspace switch at create; branch `b3g` adds a directory outside the shared
  folder as a pointer for a session created in it and states in the ovnfs
  `<workspace>` line where commands and relative paths start and that reading the
  project in place is fine; branch `b3h` keeps the arbor session's cwd the
  directory the user picked, so the sidebar shows it under that row instead of
  under a "shared" row, never registers the shared folder as a DSH workspace, and
  marks arbor's rows `（Arbor）` in the sidebar browser. Branch `b3i` closes the
  reload question on both sides: `@4fu/dsh-arbor-ui-workspace` holds a cold page's
  restore of a saved blank until the session's recorded preset is in the client's
  cache, and the driver never reverse-routes a session whose creation header says
  `agentPreset: 'arbor'`, re-asserting its label through the registry's own
  `select` instead. The `b3h` live finding — a plain reload turning an Arbor
  session into a Standard one — did not reproduce on this tree (two reloads and a
  browser relaunch, no `agent-preset/selected` at all), and the correction is
  recorded in `docs/b3b-projects-and-sandbox.md`.
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
- **Picking Arbor in a composer that is not the hero runs arbor.** DSH's preset
  registry commits the staged pick as an `agent-preset/selected` event on the
  session log; the driver observes that event, ends the embedded agent with the
  handle its creation returned, and opens the same session id under arbor, so the
  session keeps its identity and its log and its next turn runs arbor. A
  selection after the first turn is refused by DSH with a visible reason ("This
  session has already started"), and the driver guards on the turn boundary as
  well: nothing silently keeps the driver it began with. Which way a selection
  *before* the first turn is followed depends on where the session's arbor came
  from: a blank that selected arbor goes back to the embedded loop when it
  selects another preset, and a blank **created** as arbor is never moved off it
  — the only selection that can reach it is the controller's own default
  re-select on a reused blank, and the driver puts the label back through the
  registry's own `select` instead. Proof 15 covers both halves.
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
- **Picking Arbor in the web hero mints a session created as arbor** (`b3f`).
  `@4fu/dsh-arbor-ui` shadows the hero's `conversation.hero.agentPreset` `single`
  seat one priority below the shipped occupant, carrying the shipped component,
  locale and inject face and wrapping only the face's `select`. When the main
  session is a blank with no turn and the pick crosses the arbor boundary, the
  wrapper does not commit on that blank: it creates a new session under the
  picked preset through the client's own `sessions.create`
  (`@deepseek-ai/dsh-cordis-client-runner`, `lib/client.js`, `ISessions`), which
  is the `session/create` verb, and with no `sessionId` the host mints one —
  `createSession` → `createMinted(request.cwd,
  await this.composeAgent(request.agentPreset))`
  (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) — so the
  composition's `agentPreset` lands in the session's creation `meta`, which is
  what `ArborAgentRegistry.create` routes on. The session is created under the
  driver it runs: no swap, no `agent-preset/selected` event, no window in which
  the label and the driver disagree. It is opened through
  `uiWorkspace.openSession`, which changes the hero's session id and so
  re-resolves its session scope; the composer's draft is carried across with
  DSH's own `conversation.input` shell API, and the blank it replaces is
  archived. Both directions are minted, and the mint happens only where DSH's
  create can hold it — a project of the shared folder — so an ordinary composer's
  switch is byte-for-byte the shipped call. The driver's re-route stays as the
  fallback for a path that is not the hero (an SDK or remote
  `agent-preset/select` on a blank) and never fires on the hero path. Why the
  owner's option (a) — one stable routing handle — cannot be built on
  dsh-v0.2.2-rc.1, with the three lines of source that close it, is in
  `docs/b3b-projects-and-sandbox.md`. Proof 19 drives the host half of the
  create and asserts the header, the routing, the absence of a selection event
  and the absence of a resume.
- **Adding a workspace carries the pick at create** (`b3f`). DSH's picker adopt
  path names no preset — the hero's `onPick` reaches
  `uiWorkspace.openWorkspace(workspaceId, beforeOpen)` with no options bag — and
  `openWorkspace` → `connectBlank` → `createInWorkspace` forwards
  `options.agentPreset` to `sessions.create` when it is given, so
  `@4fu/dsh-arbor-ui-workspace` wraps that one method on the service instance and
  fills the option in only when the caller gave none and the composer's pick is
  Arbor. The shipped path is otherwise untouched, and the host records no second
  `agent-preset/selected`. This replaces the `b3e` re-commit, which is what made
  DSH's `reuseLive` follow the pick back off arbor.
- **A directory outside the shared folder takes the pick at create too** (`b3h`,
  which reversed the `b3f` limitation). `DshProjectBridge.resolveProject` answers
  the requested directory as-is, so a session created under arbor for a directory
  the user added keeps that directory as its cwd, is a member of that workspace,
  and records it as an external pointer; the hero mints there as well, so the
  pick never has to be committed on a live session. The `b3f` limitation — the
  cwd resolved into the shared folder, the attach refused, the composer left
  without a workspace to name — is gone, and the `b3e` re-commit that worked
  around it is gone with it.
- **Two gate corrections in the same step**, both so that nothing untrue is left
  showing: the staged pick decides only while the session has not started a turn
  (a started session keeps the driver it began with, so only its committed
  projection is true), and the hero seat bound to the composer's session answers
  before the unbound one.
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
session and a new session is created under the preset, which is what proof 19
drives), the SDK path the proofs use (`ctx.agents.create` with
`meta.agentPreset: 'arbor'`, then `ctx.agents.resume`), or a remote
`agent-preset/select` on a blank, which the driver re-routes (proof 15). The
proofs in step 2 are the verified path for the arbor preset today.

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
