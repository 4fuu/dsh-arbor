# Installing and inspecting dsh-arbor

This page is written for an AI agent. It says what dsh-arbor is, how to install
it from a clean checkout, how to verify it, where each piece lives, what works,
and what is deliberately not finished. Follow it in order; every command is
meant to be run as given.

The canonical version pin is [docs/versions.md](versions.md). This page repeats
the current values so an agent does not have to resolve links before installing.

## 1. What you are installing

dsh-arbor runs [arbor](https://github.com/4fuu/arbor) as DeepSeek Harness's
agent driver. One DSH process mounts exactly one arbor host. Each DSH user
session that selects the `arbor` preset is a conversation of that host: its
first turn opens an arbor window, a window that ends hands off to a
continuation, and the window's reply is written to the DSH session log as an
ordinary assistant message. Sessions that do not select arbor keep running on
DSH's own embedded AgentLoop, in the same process.

Pins, and do not change them without being asked:

- DeepSeek Harness `dsh-v0.2.2-rc.1`, installed from npm as
  `@deepseek-ai/dsh@0.2.2-rc.1` and its companion `@deepseek-ai/dsh-*`
  packages at `0.2.2-rc.1`.
- arbor `@4fu/arbor-*` `2026.1109.1`, from npm. `@4fu/arbor-errors` is
  `2026.1107.0`, the only published version.
- This repository's packages are `@4fu/dsh-arbor-*`, are `private`, and are
  not published. Installing means checking out this repository.
- The optional font plugin lives in
  [dsh-arbor-fonts](https://github.com/4fuu/dsh-arbor-fonts) and is pinned to
  the same DSH version.

## 2. Requirements

- Node.js 24.9 or newer (developed on Node 26). The sources are TypeScript run
  directly through Node's type stripping, so there is no build step.
- pnpm 11.28.5. `.agents/setup` installs exactly that version with npm into
  `~/.local/bin`; corepack's pnpm shim does not run under Node 26. To do it by
  hand: `npm install -g pnpm@11.28.5`.
- `DEEPSEEK_API_KEY` in the environment only if you want to run the proofs
  against the real model. The default proof run uses a scripted model and needs
  neither a key nor network access.

## 3. Clone and install

```bash
git clone https://github.com/4fuu/dsh-arbor
cd dsh-arbor
pnpm install --frozen-lockfile
```

`pnpm install` must finish with exit code 0. If it exits 1 with
`ERR_PNPM_IGNORED_BUILDS`, the dependency install-script policy in
`pnpm-workspace.yaml` is missing or was edited: pnpm 11 refuses to finish while
a package with an install script is neither approved nor explicitly denied.
All six packages this repository pulls in that carry install scripts are
deliberately denied there, each with its reason. Do not "fix" the error by
approving them; node-pty in particular would have to compile a native addon on
Linux for a code path nothing here uses.

Then verify the tree is self-consistent:

```bash
pnpm check:pin       # every DSH dependency and DSH_PINNED_VERSION is 0.2.2-rc.1
pnpm check           # tsc --noEmit over every package and proof
```

The pin check reads every manifest under `packages/` and `proofs/`, every
`engines.dsh` declaration, and the `DSH_PINNED_VERSION` constant in
`packages/arbor-prompt/src/sections.ts`. A
different DSH version is unsupported; see [versions.md](versions.md) for what
can break.

## 4. Run the proofs

```bash
pnpm proofs          # all twenty-nine, in order, against the scripted model
```

Each proof prints one `PASS` or `FAIL` line per assertion and a final
`PROOF n OK`. The suite takes about a minute. A single proof runs on its own:

```bash
pnpm proof:boot              # 00 the boot harness: the shipped profile, one turn
pnpm proof:routing           # 01 per-preset routing with an embedded AgentLoop
pnpm proof:roundtrip         # 02 message -> arbor window -> streamed assistant message
pnpm proof:hidden            # 03 window agents hidden from the session list
pnpm proof:approval          # 04 an approval reaches DSH's approval path
pnpm proof:prompt            # 05 prompt assembly: drops decided, third party in <dsh>
pnpm proof:plugins           # 06 common DSH plugins still work
pnpm proof:preset            # 07 the arbor preset in the roster, routing both ways
pnpm proof:storage           # 08 durable storage, one host, workspace root
pnpm proof:lifetime          # 09 window end, continuation, idle timeout
pnpm proof:resume            # 10 a persisted session resumes after a restart
pnpm proof:sandbox           # 11 arbor's own workspace over the shared folder
pnpm proof:harness           # 11 the rendered prompts, the deltas, the tool sets
pnpm proof:env               # 12 /env: DSH's skills and MCP servers, read-only
pnpm proof:sections          # 12 the decision table against the pinned DSH
pnpm proof:loop              # 13 the closed loop, across a restart
pnpm proof:send-links        # 13 what <harness> promises about send and @path
pnpm proof:windows           # 14 two windows on one project do not collide
pnpm proof:preset-selection  # 15 picking Arbor in a composer runs arbor
pnpm proof:external-project  # 16 add-workspace becomes a pointer for that session
pnpm proof:project-section   # 17 the session's project is named once in <workspace>
pnpm proof:picker-pin        # 18 the picker filter is pinned to the shipped plugin
pnpm proof:hero-create-routing # 19 the hero pick creates the session as arbor
pnpm proof:ovnfs-project     # 20 the ovnfs project line: paths and reading in place
pnpm proof:arbor-workspace-membership # 21 the session belongs to the picked workspace
pnpm proof:reload-preset     # 22 a cold client restores a blank under its recorded preset
pnpm proof:facts             # 23 the panel facts and live stream are arbor's own
pnpm proof:host-facts        # 24 the whole-host view names only labeled sessions
pnpm proof:backend-session   # 25 the backend session's own state, idle and running
```

A proof removes every temporary directory it made when it reports, so a run of
`pnpm proofs` leaves the system temp directory as it found it. Before booting a
profile it points `TMPDIR` at one of those registered directories, so DSH's
`dsh-spill-*`, `dsh-subprocess-*` and workspace-change directories are removed
with it too.

Every proof boots the shipped DSH `headless` profile from npm and composes the
bundle's own patch file as its first overlay, so what a proof boots is what an
installed deployment composes.

Against the real DeepSeek model instead (needs `DEEPSEEK_API_KEY`):

```bash
ARBOR_PROOF_LIVE=1 pnpm proofs          # or a single proof
```

Known behaviours of that mode:

- The real model now and then answers a one-word prompt with reasoning only, so
  the assistant output is empty. Proof 1 retries that turn a couple of times.
- `ARBOR_PROOF_LIVE=1` runs every proof against the profile's own default model.
  Only proof 13 changes what it asserts under it; the others keep the scripted
  path and need no key.
- A proof process exits as soon as its report is printed. A handle that DSH's
  profile or arbor's host leaves open must not hang the suite; DSH's own smoke
  harness runs each fixture in a subprocess with a timeout for the same reason.
  See `packages/arbor-testkit/src/finish.ts`.

## 5. Drive one live turn, including a restart

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
real model it also shows the end-to-end result: the model reads a DSH skill's
`SKILL.md` through arbor's own `read` tool and answers from it, runs a command
in the arbor workspace, and calls a DSH MCP tool as a DSH tool.

## 6. Boot the web profile

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

It prints `dsh web: http://127.0.0.1:3080/?token=...`. Open that URL in a
browser. The hero composer has the workspace chip, the preset chip and, for a
Standard composer, the sandbox access-mode switch. Picking Arbor on the hero
creates a new session under the preset (`session/create` with `agentPreset`,
no `sessionId`); proof 19 drives that path. The older path
(`ctx.agents.create` with no preset, then `agentPresets.select(agent, 'arbor')`)
is what an SDK or a remote `agent-preset/select` still takes, and proof 15
drives it.

### 6a. The Arbor page

`@4fu/dsh-arbor-ui` adds one permanent entry to DSH's left navigation and one
root-scoped page behind it. The page is the whole-host picture. It reads three
exact Fetch routes registered by `@4fu/dsh-arbor-facts` through
`ctx.connection.fetch.register`:

- `GET /api/arbor/host` — every labeled arbor session, its window chain, the
  board, the active notes, `/env`, the schedules and arbor's settings, then each
  rebuild and each live `Arbor.stream(window, ...)` delta as NDJSON;
- `GET /api/arbor/facts?sessionId=...` — the same read for one session, used by
  that session's tab;
- `GET /api/arbor/search?q=...` — arbor's own `Arbor.search`, over its journal,
  notes and board.

A session is an arbor session because arbor says so: the driver sets
`TaskInput.label` to the DSH session id, and arbor carries that label onto the
window, its continuations, the `window_start` event and the per-window prompt
section. The host view reads the labels, not a `windowStart` map kept in the
browser. Expanding a session opens its own tab with only that session's current
state: the live window and its status, the continuation chain with end reasons
and handoffs, the project and external pointers from `<workspace>`, and what is
running now. An ordinary DSH session has no such tab; the permanent left entry
still opens the host view, which does not list it.

The page leads a session card with DSH's own session title, and keeps the
project and the window-chain summary as secondary lines. The UI text is Chinese
with an English dictionary registered in the `arborUi` locale namespace, so
DSH's language switch switches the page.

An `end` arbor refuses is shown as its own note on the window card, not as an
ended window. The journal records the refusal (`end.handoff.invalid` for a
handoff whose fields are not the required string arrays) with the rule and
arbor's next action, the window stays live and idle, and the note says what the
reader can do now: send another message in DSH to keep working, or let the model
call `end` again with the named fields. The note disappears when a later `end`
succeeds or the window really ends.

The layout is a measured skyline scatter, not a grid. Cards are placed in
importance order (live windows, chain, session, board, notes, environment,
schedules) at the lowest skyline point where their width fits, ties to the left,
with a 20 px gutter. Heights come from the rendered cards; notes and board cards
are paper with a small tilt, and hovering one straightens and lifts it. A
floating bottom dock filters 全部 / 窗口 / 看板 / 笔记 / 环境 / 日程; search and
settings are the two top-right icons. All colours, borders and elevation come
from `--dsw-*` tokens, so DSH's light and dark appearance both work without the
page choosing a theme.

What the page shows comes from arbor, not from a browser guess:

- windows and the chain: `ArborHostService.windowChainOf`, `Arbor.live()` and
  the journal's `window_start`, `window_end` and `board_line` events;
- a window's run state and cost: the journal's `usage` and `run_ended` events,
  read after the window's live record is gone; the facts service subscribes to
  arbor's journal appends, never to a backend's event bus;
- a refused `end`: the journal's `tool_result` for the `end` `tool_call`, when
  its rule is `end.*` and the window is still live;
- a handoff's four parts: the model's `end` tool call in the journal;
- workspace: the workspace implementation's project, pointers, checkouts,
  keeps and open work;
- notes: `NoteStore.snapshot()`, the active set frozen by its epoch;
- `/env`: `Environment.list()` plus the journal's `service_state` events;
- schedules: `Arbor.schedules()`;
- settings: `Environment.settings()`, falling back to the deployment's seed.

Proof 23 covers the per-session facts and the live stream; proof 24 covers the
host view, the session title, the label, the journal's run records, a refused
`end` and a delivery into an idle window; proof 25 covers the backend session's
own idle/running state and its delivery mapping.

### 6b. Typography contract

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
own role property, because a font plugin sets the property on the role nodes
itself. A font plugin may target `[data-arbor-page]` and `[data-arbor-text]`
and override only these four custom properties; it must not depend on class
names or page structure. This package vendors no font files.

### 6c. ovnfs for real

**ovnfs is chosen only when its binary is on `PATH`.** `openWorkspace` runs
`execFile('ovnfs', ...)` and falls back to the plain-directory workspace when the
binary is missing or its daemon will not start. The proofs stage a stand-in
(`useOvnfsStub`). To run the real one, mirror arbor's own CI:

```bash
sudo apt-get install -y fuse3
base=https://github.com/stencil-hq/ovnfs/releases/download/v0.1.1
curl -fsSL -O "$base/ovnfs_0.1.1_linux_amd64.tar.gz" -O "$base/ovnfs_0.1.1_checksums.txt"
grep ' ovnfs_0.1.1_linux_amd64.tar.gz$' ovnfs_0.1.1_checksums.txt | sha256sum -c -
mkdir -p ovnfs-bin && tar -xzf ovnfs_0.1.1_linux_amd64.tar.gz -C ovnfs-bin ovnfs
export PATH="$PWD/ovnfs-bin:$PATH"
ovnfs version          # ovnfs v0.1.1
```

With that binary on `PATH` the host reports `workspaceBackend = ovnfs` and
mounts `<DSH_HOME>/arbor/ovnfs/checkouts` as `fuse.ovnfs`. The mount is the
checkouts directory, not the shared folder, so projects can still be seeded
into `<DSH_HOME>/arbor/shared` after boot. Ubuntu's `fusermount3` AppArmor
profile only allows mounts below `$HOME`, `/mnt`, `/media` and `/tmp`, so keep
`TMPDIR` (and therefore `DSH_HOME`) under one of those on a stock Ubuntu
runner.

An ovnfs window opens a copy-on-write checkout of the project it needs and
merges back with `workspace.apply`. A plain-directory window works in place.
Both are arbor's workspace; neither is a sandbox.

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
for p in host driver llm prompt tools workspace env facts ui ui-workspace bundle preset; do
  ln -sfn "$PWD/packages/arbor-$p" "$P/node_modules/@4fu/dsh-arbor-$p"
done
# add "@4fu/dsh-arbor-bundle" to dsh.profile.bundles in "$P/package.json"
dsh arbor --dump-config        # the composed tree, with the arbor rows in it
```

`dsh arbor "Reply with the single word: pong"` then runs an ordinary session
through the arbor routing registry and the embedded official loop, and
`$DSH_HOME/arbor/` holds `journal.sqlite`, `notes.sqlite` and the `env/`
directory the environment lives in. For the Arbor page, use the `web` profile
instead of `headless`; the bundle carries the two `dsh.client` packages and the
facts route registers on DSH's browser connection.

The bundle keeps the rows a real installation already has: the base profile's
`bash-sandbox`, `fs-sandbox`, `sandbox`, `sandbox-policy` and `approval` rows.
They confine the ordinary sessions that run on the embedded AgentLoop. Arbor
sessions do not use them, because arbor's file tools run on the host, so nothing
about an arbor session depends on whether they are mounted.

What the installed CLI cannot do: drive an arbor-preset session. The one-shot
runner refuses to adopt any session that runs under a preset
(`session "..." runs under agent preset "arbor", which the one-shot runner does
not compose`) and has no flag to select one. A session reaches arbor from a
surface that composes presets: the web client's hero chip (proof 19), the SDK
path the proofs use (`ctx.agents.create` with `meta.agentPreset: 'arbor'`, then
`ctx.agents.resume`), or a remote `agent-preset/select` on a blank (proof 15).

## 8. Inspect what ran

- `$DSH_HOME/arbor/journal.sqlite` is the arbor journal: every window start and
  end, every task, every tool call and result. `$DSH_HOME/arbor/notes.sqlite` is
  the note store beside it. Read the journal with `node:sqlite`, which needs no
  extra tool:

  ```js
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(`${process.env.DSH_HOME}/arbor/journal.sqlite`, { readOnly: true })
  console.log(db.prepare('select seq, kind, window, body from events order by seq').all())
  ```

  A `tool_registration` event with `rule: "tool.name_taken"` records that
  arbor's own tool already held the name DSH's tool was offered under. Every
  event that belongs to a DSH session carries that session as a target
  (`dsh:session:<id>` in `event_targets`), which is how the host knows which
  window belongs to which session after a restart.
- A window's workspace is arbor's own, over the arbor shared folder under
  `$DSH_HOME/arbor/shared`: ovnfs when its binary is found and its daemon starts
  (a copy-on-write checkout per window, opened with `workspace.checkout`, merged
  back with `workspace.apply`), the plain-directory workspace otherwise.
- The session log is DSH's own: `assistant/message` events carry the streamed
  reply, `tool/call` and `tool/result` pairs carry every tool call the window
  ran, and `turn/end` closes each turn.
- The composed profile tree is visible with `dsh --profile <name> --dump-config`
  in a real installation, and with the loader entries a proof prints.

## 9. Release notes

The current package metadata is prepared for a public repository and a future
npm release, but the packages are still `private: true` and version `0.0.0`:

- every package carries `license: MIT`, a repository URL with its package
  directory, `engines.node >=24.9.0`, `engines.dsh: 0.2.2-rc.1`, and an
  explicit `files` list;
- the runtime packages carry `publishConfig.access: "public"` (the scope is
  `@4fu`), but no `npm publish` has run;
- the bundle's dependencies are `workspace:*`, and its siblings are `0.0.0`, so
  a release still needs a version for every package and the workspace specs
  rewritten to those versions; every package now ships its MIT `LICENSE`;
- the fonts plugin is a separate repository and package, with its own checks and
  the SIL OFL text for its vendored fonts.

The bundle is not published, so a normal installation is a checkout plus the
profile wiring in section 7. Do not publish anything as part of an install or a
review unless the repository owner explicitly asks.

## 10. The prompt bridge

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
  nothing from outside.

Everything official is decided one by one in
`packages/arbor-prompt/src/sections.ts`, and the table is pinned to
`dsh-v0.2.2-rc.1`: `proofs/12-official-sections.ts` fails when the pinned DSH
registers an official section name the table does not decide, so a DSH upgrade
cannot let a new section in silently.

The decisions that matter for an arbor session:

- `sandbox:policy` is dropped. An arbor session does not run through DSH's
  sandbox, so `<harness>` writes no sandbox line.
- `working-directory:current` is dropped, and it is dropped from the
  runtime-context snapshot too, so the paths have exactly one home: arbor's own
  `<workspace>` section.
- `@path` references resolve from arbor's workspace root, which is arbor's
  shared folder for an arbor session.
- `working_directory` and `skill` are restricted for arbor sessions.
  `working_directory` is DSH's project management, which arbor owns; `skill` is
  `read` of the `SKILL.md` that `<env>` already names, and arbor's own `read`
  reaches it. `read_image` stays: it returns the image itself, which arbor's
  text-only `read` cannot.
- The host's arbor settings carry no `generalRules`; arbor's own seven rules
  render in Chinese instead of B0's English replacements.

The dynamic parts — the approval policy and plan mode — reach a running window
as a `prompt_delta` carrying only the changed lines, and a delta never starts a
turn: it goes in at the next step boundary and is read by the turn that follows.

## 11. If something fails

- `ERR_PNPM_IGNORED_BUILDS` on install: see section 3.
- `pnpm check:pin` fails: a manifest or `DSH_PINNED_VERSION` is not
  `0.2.2-rc.1`. Do not widen the range; read [versions.md](versions.md).
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
- Anything else: the findings in `docs/b0-findings.md`,
  `docs/b3-findings.md` and `docs/b3b-projects-and-sandbox.md` record where each
  integration point lives in DSH's own sources. They are historical records;
  this page is the current status.
