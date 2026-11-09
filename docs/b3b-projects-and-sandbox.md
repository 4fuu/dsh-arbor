# B3b findings: arbor takes over DSH's projects, and the sandbox goes away

> **Historical record.** This page records the B3b decisions and the evidence
> behind them. It is kept because every finding names the DSH source it rests
> on. The current install and status are in
> [install-for-agents.md](install-for-agents.md), and the current version pins
> are in [versions.md](versions.md). At the time of B3b, arbor was
> `2026.1107.1`; the current arbor pin is `2026.1109.1`.

B3 mounted arbor's own workspace *over* DSH's sandbox: every file access and
command of an arbor window ran through `ctx.fs` and `ctx.shell` under the
session's sandbox policy, and ovnfs was deliberately not offered because its
host-side `node:fs`, `spawn('/bin/sh')` and daemon subprocess would be a hole
through that sandbox.

The owner's decision reverses part of that, on the principle of maximal glue:
**for arbor sessions, arbor takes over DSH's project management and DSH's
sandbox goes away, and the UI changes in the same step.** Arbor's tools run on
the host the way they do in standalone arbor; the only protection is arbor's own
secret scrub on what reaches the model. DSH's implementation, prompt and UI are
adapted or hidden to match, so nothing is left that is untrue to the model or to
the user. **Ordinary DSH sessions — the ones on the embedded official AgentLoop
— do not change at all:** they keep their sandbox, their cwd and their tools.

Every finding below names the DSH source it rests on. DSH is tag
`dsh-v0.2.2-rc.1`; at the time of this record arbor was `2026.1107.1`.

## The mechanism table

Every DSH mechanism this step touches, what an arbor session does with it, and
where it lives in DSH. "Removed" means the mechanism no longer governs an arbor
session; "kept" means it still does.

| DSH mechanism | Arbor sessions | DSH source location |
| --- | --- | --- |
| **Projects** (`Workspace` registry) | Arbor's shared folder is the source of truth. A DSH project is a project subfolder of the shared folder, registered in the registry so the UI lists it. | `@deepseek-ai/dsh-workspace` (`WorkspaceRegistry`, `Workspace`, `ctx.workspaceRegistry`); served by `@deepseek-ai/dsh-api-workspace-controller` |
| **Project list / picker / creation** (client) | Reads arbor's projects because the client reads the registry the bridge fills. **Decision (item 2), landed on `b3d`:** an ordinary session lists nothing from arbor's shared folder, and an arbor session lists those projects plus the directories the user added outside them, marked `（外部）`. The filter is a `dsh.client` package (`@4fu/dsh-arbor-ui-workspace`) that wraps `ctx.slots.register` and replaces only the hero picker's component; the shipped row stays enabled. Neither side offers a per-session view of the workspace list, and the preset the filter keys on exists only in the browser — see "The picker filter, as built" below. | `@deepseek-ai/dsh-client-ui-workspace` (`WorkspacePicker`, `WorkspaceBrowser`, the `conversation.hero.workspace` and `sidebar.workspaces` seats); `@deepseek-ai/dsh-api-workspace-controller` (`WorkspaceView`); the registry `ctx.workspaceRegistry` in `@deepseek-ai/dsh-workspace` |
| **Add workspace…** (client) | Records a pointer for the arbor session that asked, with no new verb and no client change. The action reaches `WorkspaceRegistry.create`, the bridge hooks it, and the driver asks at the two moments a session becomes an arbor session whether the directory it names was added. | `@deepseek-ai/dsh-api-workspace-controller` (`create`, the `workspace/create` verb — the one caller of `WorkspaceRegistry.create` besides this bridge's own sync); `WorkspaceRegistry.initializeDefault` (the first-use default, a different method, so an inherited cwd is never an added directory) |
| **External-project pointer** (prompt) | An existing directory with its own path is recorded as a pointer (name + absolute path), never copied, linked, adopted or registered as a project. It is named in arbor's prompt so the model reaches it on the host directly. Recorded **per session**, and rendered inside arbor's `<workspace>` through `PromptSection.content(window)` with `perWindow: true`. | `@4fu/dsh-arbor-workspace` (`DshProjectBridge.addPointer`/`listPointers`/`removePointer`/`isAddedDirectory`); arbor's `<workspace>` section from `@4fu/arbor-prompt` / arbor-core; the `windowStart` hook in `@4fu/arbor-interfaces` (`Hooks`) |
| **Preset selection** (`agent-preset/selected`) | Two paths, and the hero one is now a *create*. The hero composer's Arbor pick mints a new session under the picked preset (`meta.agentPreset` at create), so the session is created under the driver it runs and no selection event is written; the mint runs for every workspace row the client has listed, in both directions. A selection that does arrive on a blank session — an SDK or remote `agent-preset/select` — is still observed by the driver, and which way it is followed depends on provenance: a session that *selected* arbor goes back to the embedded loop when it selects another preset, and a session *created* as arbor is never moved off it, because the only selection that can reach it is the controller's own default re-select on a reused blank. A selection after the first turn is refused by DSH with a visible reason. | `@deepseek-ai/dsh-agent-preset-registry` (`select`, `agent-preset/locked`, `agentPresetProjectionDefinition` with no `wire.summary`); `@deepseek-ai/dsh-api-session-controller` (`createSession` → `createMinted(cwd, composeAgent(agentPreset))` → `createAgent` builds `meta.agentPreset`; `reuseLive`; `reuseSetup`); `@deepseek-ai/dsh-cordis-client-runner` (`ISessions.create`); `@deepseek-ai/dsh-client-ui-agent-preset` (`AgentPresetSeatController.select`/`apply` → `ctx.remote.agentPresets.select`); `@deepseek-ai/dsh-client-ui-workspace` (`restoreBlank`) |
| **Session cwd** (`working-directory:current`) | Not bound to one cwd. The session's cwd is the shared folder (or the project subfolder it was opened on, resolved the same way either path); a window works in its ovnfs checkout of whichever project it needs, and `<workspace>` names the shared folder, the session's project and how the window reaches it. | `@deepseek-ai/dsh-working-directory` (`WorkingDirectoryService`, `working-directory/change`); the `workingDirectory` projection in `@deepseek-ai/dsh-session-projection`; prompt section `working-directory:current` |
| **Sandbox modes** (`sandbox/mode`, policy) | Removed. Arbor's file tools run on the host; no mode is resolved for an arbor window and no `sandbox/mode` event is emitted for it. | `@deepseek-ai/dsh-sandbox-policy` (`SandboxPolicyService`, `ctx.sandboxPolicy`, `sandboxMode` projection); `@deepseek-ai/dsh-sandbox` (`SandboxMode`) |
| **Sandbox enforcement** (`ctx.fs`, `ctx.shell`) | Not used by arbor's tools. They reach files through arbor's own workspace (`node:fs`, `spawn('/bin/sh')` on the host), exactly as in standalone arbor. The sandbox rows stay mounted for ordinary sessions. | `@deepseek-ai/dsh-fs-sandbox` (`SandboxedFileSystem`); `@deepseek-ai/dsh-bash-sandbox` (`SandboxBashExecutor`); `@deepseek-ai/dsh-sandbox-local` |
| **Escalation** (`sandbox_escalate`, `approveEscalation`, `sandbox_permissions`) | Removed. There is no escalation tool and no per-call permission argument to widen; nothing a window does is confined, so there is nothing to widen. | `@deepseek-ai/dsh-sandbox` (`escalation.d.ts`, `approveEscalation`, `ESCALATION_TARGETS`); `@deepseek-ai/dsh-tool-fs` / `dsh-tool-bash` |
| **Tool approval** (`approval:policy`, `ctx.approval`) | **Kept.** It is separate from the sandbox: a tool call that needs approval still routes through DSH's approval on the user session's agent, and arbor's tools run through `ctx.tools.execute` the same way. | `@deepseek-ai/dsh-user-approval` (`ctx.approval`, `approval/request`); `@deepseek-ai/dsh-tools` (`pipeline.ts`, `serviceAsk`) |
| **Sandbox mode switch** (client) | Hidden for arbor sessions. `@4fu/dsh-arbor-ui` shadows the `conversation.input.permission` `single` slot one priority below `@deepseek-ai/dsh-client-ui-permission-presets`' occupant and renders the real control for an ordinary session, nothing for an arbor one (whose `useProjection("agentPreset")` is `"arbor"`). The switch is gone from an arbor composer; an ordinary composer keeps it byte-for-byte. | `@deepseek-ai/dsh-client-ui-permission-presets` (`PermissionSelect`, seat `conversation.input.permission`); `@deepseek-ai/dsh-client-ui-conversation` (the `single` slot, `entriesOfSlot`); the preset projection `agentPreset` in `@deepseek-ai/dsh-agent-preset-registry` |
| **cwd display** (client) | Unchanged and honest: the session's cwd *is* the arbor shared folder, so the display names a real directory. No client change is needed. | `@deepseek-ai/dsh-client-ui-workspace` (session header cwd, `path-suffix`) |
| **Prompt sections** `working-directory:current`, `sandbox:policy` | Dropped for arbor sessions. Arbor's own `<workspace>` section carries the method instead. The per-section decision table is the prompt bridge's (B2). | `@deepseek-ai/dsh-*` `systemPrompt.section` registrations; the prompt bridge in `@4fu/dsh-arbor-prompt` |

## What arbor's workspace is now

`@4fu/dsh-arbor-workspace` no longer talks to DSH's filesystem or shell. It
opens arbor's own workspace over the shared folder with arbor-core's
`openWorkspace` (`@4fu/arbor-core`, `workspace.js`):

- **ovnfs** (the default) when its binary is found and its daemon starts: one
  shared folder — `DSH_HOME/arbor/shared` — holding several projects and git
  repositories, with a copy-on-write checkout per window that a window opens
  (`workspace.checkout`), works in and merges back (`workspace.apply`)
  (`@4fu/arbor-workspace-ovnfs`).
- the **plain directory** workspace when ovnfs is unavailable: one directory per
  window under `DSH_HOME/arbor/workspaces`, plus persistent directories
  (`@4fu/arbor-workspace-dir`).

The `<workspace>` prompt section and the `workspace.*` module functions are the
backend's own — arbor's wording, arbor's method, no sandbox line and no
`sandbox_escalate`. Removed with the sandbox: `DshSandboxSeam`,
`DshSandboxWorkspace`, `sandbox_escalate` and `ctx.arborHost.fileToolsSandboxed`.

## Decisions

1. **The shared folder is the source of truth.** `DSH_HOME/arbor/shared`, beside
   the journal and the note store, so a restart keeps every project. A DSH
   project is a subfolder of it; the project bridge registers each as a DSH
   `Workspace` at host start and keeps the list live as the folder changes.
2. **An arbor session is not bound to one cwd.** The driver resolves the session's
   cwd to the directory the user picked — the shared folder, or a project
   subfolder of it — the same way on both paths, and a window opens a checkout of
   the project subfolder it needs. `<workspace>` names the shared folder, the
   session's project and the checkout method.
3. **An existing DSH project with its own path is named as a pointer, not
   copied.** `DshProjectBridge.adopt(path)`'s copy is gone: no copy, no mount, no
   adoption. Arbor's tools run on the host, so the model reaches the user's own
   directory directly at its absolute path, and a change there lands on the
   user's files with no checkout and no apply. A pointer is recorded only where
   an arbor session asked for it — a session that became an arbor session while
   naming a directory the user had added through DSH's own add-workspace action —
   and never in `resolveProject`, which runs for every session whatever cwd its
   caller named. Pointers are recorded per session, so a directory one session's
   user added is invisible to a session that never asked.
4. **The sandbox is gone for arbor sessions, and so is its escalation.** No mode
   is resolved, no `sandbox/mode` event is emitted, no escalation tool exists,
   and arbor's file tools run on the host. DSH's tool approval is kept — it is a
   separate mechanism and stays.
5. **Ordinary sessions are untouched.** The routing registry still sends every
   non-arbor session to the embedded AgentLoop; the sandbox rows stay mounted and
   their file policy still applies to those sessions' tools. Proof 8 asserts an
   ordinary session keeps its cwd and that `ctx.sandboxPolicy` is still present.
6. **Picking Arbor in a composer runs arbor, and a switch after the first turn is
   refused rather than silently kept.** The registry routes every session through
   the arbor driver while it is mounted, and the driver re-routes a blank session
   that selects arbor: the embedded agent is ended with the handle its creation
   returned and the same session id is opened under arbor, so the session keeps
   its identity and its log. DSH's own registry refuses a selection on a session
   that has started a turn with a visible reason, and the driver guards on the
   turn boundary as well; nothing ever keeps the driver it began with in silence.

## What is kept from B3

- `/env`: DSH's skills and MCP servers, read-only, beside arbor's own
  (`@4fu/dsh-arbor-env`). Unchanged.
- The driver's refusal text: a refused call still reaches the model with the
  rule, the message and the next action.
- Resume after a restart: the host continues a stopped window from the journal,
  and the shared folder and its projects survive on disk.

## The UI, honestly

The DSH web client ships as compiled browser bundles, but it is **not one sealed
bundle**: the web profile composes the browser roster from `dsh.client` plugin
packages (`@deepseek-ai/dsh-web-app`'s `cordis.patch.yml`, the `dsh.client`
section). The client module system (`@deepseek-ai/dsh-client-modules`) scans the
host loader's entries for packages declaring `dsh.client`, composes the boot
graph in module-graph order, and serves each package's `exports["./client"]` as a
classic script in the `window.__ModuleLoader__.load({ id, factory })` format; a
plugin's `require` of another client package resolves against that graph, and a
package's `dsh.client.inject` lists the client packages it depends on. A bundle
patch can `disabled: true` a row, and `applyPatches` treats a patch's `name` as a
check only, so a row is replaced, never re-pointed. That is the clean seam this
step uses — a `dsh-arbor` client package — with no patch to any compiled bundle.

**The sandbox mode switch is gone for arbor sessions** (`@4fu/dsh-arbor-ui`, a
`dsh.client` package). `conversation.input.permission` is a `single` composer
slot (`@deepseek-ai/dsh-client-ui-conversation`); a `single` slot renders its
lowest-priority occupant, and `ctx.slots.entriesOfSlot` reads an occupant with
its own fields — `component`, `inject`, `locale` sit at the entry's top level,
while the entry's `options` bag carries only `key`/`order`/`priority`
(`@deepseek-ai/dsh-client-ui-slots`, `SlotCore.register`). arbor-ui registers its
own occupant one priority below `@deepseek-ai/dsh-client-ui-permission-presets`'
`PermissionSelect`, reusing that component, inject face and locale, and gates it
on the preset the composer is about to run: `"arbor"` renders nothing, any other
preset renders the real control. permission-presets stays enabled, so its
`/permission` popup and General-settings row are untouched for both. The shipped
occupant registers through permission-presets' own deferred `inject`, on a
timeline a plugin cannot subscribe to, so arbor-ui reads it by polling
`entriesOfSlot` (bounded, stopped on success and on dispose) until it appears.

Two details of that reuse are load-bearing, and both were found the hard way:

- **The inject face and the locale must be carried over.** An occupant registered
  without them has no `t` and no `usePermissionCatalog`, so `PermissionSelect`
  throws on its first render; the slot's supervision reports the crash, abdicates
  the entry, and the outlet re-renders onto the next survivor — the shipped
  occupant. The gate then looks like it works (the ordinary control is on screen)
  while rendering nothing at all. Reading `entry.options.locale` /
  `entry.options.inject` returns `undefined`, which is exactly that trap.
- **The staged pick, not the projection, decides in the hero.** A new session's
  preset is staged before the session exists: the hero chip
  (`conversation.hero.agentPreset`) calls `AgentPresetSeatController.select()`,
  which writes the pick into that controller's own `SnapshotStore` and only then
  hands it to the current session. Until the Host commits it, the session's
  `agentPreset` projection still reads the previous value, so a gate on the
  projection alone left "Workspace Write" showing on a composer the user had just
  switched to Arbor. The gate therefore reads the staged pick through the hero
  seat's own `inject` face (`AgentPresetSeatInjected.hooks.agentPresetSeat`,
  called the way the slot runtime calls it) and falls back to the projection,
  which is what a session that already runs arbor answers with.

Verified live in the `web` profile, driven in Chromium: a Standard composer shows
"Access mode, current: Workspace Write" byte-for-byte; picking Arbor in the hero
removes it immediately, and picking Standard brings it back; an arbor session
after its first turn shows no access-mode control.

Re-verified on `b3c` with the routing fix in place: the hero with Arbor picked
carries no access-mode control, the arbor session answers with arbor's own tools
(its `bash` call lists arbor's window workspace), an ordinary session in the same
process keeps "Workspace Write" and answers through DSH's `working_directory`, and
an arbor session created for a directory added through "Add workspace…" quotes the
pointer line out of its own `<workspace>` section verbatim.

Re-verified on `b3d` in the browser, on the ovnfs backend with the real binary:
a Standard hero keeps "Workspace Write" and its picker lists nothing from arbor's
tree; an Arbor hero has no access-mode control and its picker lists the shared
folder's projects plus the added directory marked `（外部）`; and the arbor
session's first tool call goes straight to the project the user picked.

**Picking Arbor in the hero now runs arbor** (this is the finding the previous
revision of this page left open, and it is fixed). `ArborAgentRegistry.create`
routes on `options.meta.agentPreset === 'arbor'`, and DSH's session controller
builds that meta from the composition it resolves **when the session is
created** (`@deepseek-ai/dsh-api-session-controller`, `createAgent`), so a hero's
blank session — created with no preset, because the chip's pick is staged before
the session exists — started on the embedded loop and stayed there: the chip's
later pick only advanced the projection.

The first fix used DSH's own event rather than a new surface, and it is still
what covers the paths that are not the hero. The hero chip
(`@deepseek-ai/dsh-client-ui-agent-preset`, `AgentPresetSeatController.select`)
stages the pick and then `apply()`s it, which reaches
`ctx.remote.agentPresets.select(session.id, id)` — the same call the settings
section and the TUI make — and DSH's preset registry
(`@deepseek-ai/dsh-agent-preset-registry`, `select`) commits it by
`recompose`-ing the session's composition and appending `agent-preset/selected`
to the session log. That log event is the seam: the registry routes every
session through the arbor driver while it is mounted (the driver keeps the
embedded loop's handle for the others), and the driver observes
`session/event` — the session-scoped observer channel, because the registry's own
`agent-preset/selected` emit stays on the registry's context and reaches nobody
outside it — ends the embedded agent with the handle its creation returned, and
opens the same session id under arbor, the way a restart opens it. The session
keeps its identity, its log and every event it already committed, so the composer
bound to it keeps working; what changes is which driver its next turn runs.

On `b3f` the hero path stopped using that seam at all: it creates the session
under the picked preset instead, so no selection event is written and nothing is
re-routed (see below). The re-route remains for an SDK or remote
`agent-preset/select` on a blank, which is the one other writer of that event.

**A switch after the first turn is refused, not silently kept.** DSH's own
registry refuses a selection on a session that has started a turn with
`agent-preset/locked` — "This session has already started" — so the hero chip
shows that reason as its own refusal and the session keeps the driver it began
with, visibly. The driver guards on the turn boundary as well, because the one
outcome that is untrue to the user is a session that answers as arbor while
running the embedded loop (or the reverse) with nothing said. Proof 15 drives
the controller's own path and asserts both halves.

**A switch before the first turn is followed in one direction only, and decided
by provenance.** The event carries both directions, and which one is honoured
depends on where the session's arbor came from:

- a session that **became** arbor through a selection — the SDK or remote
  `agent-preset/select` path — goes back onto the embedded loop when it selects
  another preset while it is still blank: the arbor agent is ended with the
  teardown this driver holds, the window keeps running out arbor's own idle
  policy, and the same session id is opened again on the embedded loop with the
  same log and the same cwd.
- a session that was **created** as arbor (`meta.agentPreset` at create) is never
  moved off it here. Its creation header is a frozen creation fact
  (`@deepseek-ai/dsh-agent-preset-registry`, `lib/types/session.js`), and every
  surface that knows what the user clicked creates the session under the picked
  preset instead of switching a blank in place — the hero mint, and the
  add-workspace adopt at create — so the only selection that can still reach
  such a session is DSH's own: the session controller re-selects the resolved
  deployment default whenever a blank is reused with no preset named
  (`reuseLive` calls `presets.select` with `composition.agentPreset`, and
  `reuseSetup` appends the event itself, both in
  `@deepseek-ai/dsh-api-session-controller`, `lib/index.js`). The log cannot
  tell that re-select from a user's pick, because `presets.select` is the single
  writer of `agent-preset/selected`, so the attribution comes from the header
  instead: the session keeps arbor, and its label is put back through the
  registry's own `select` so the projection and the driver agree
  (`reassertArbor`). That is defence in depth behind the client fix below, which
  is what keeps the re-select from being written at all.

Proof 15 drives both halves: a blank created under arbor keeps arbor when another
preset is selected on it and its log ends on arbor again, and a blank that
selected arbor goes back to the embedded loop when it selects another preset.

`ownsSession` still folds the log's `agent-preset/selected` events over the
creation header, following DSH's own reconstruction rule for exactly this reason
(`@deepseek-ai/dsh-agent-preset-registry`, `lib/types/session.js`: the
`agentPreset` projection, "never the header alone"), so a session re-routed to
arbor comes back as arbor after a restart instead of silently resuming on the
embedded loop.

**The external-project pointer is recorded per session, not copied**
(`@4fu/dsh-arbor-workspace`). `DshProjectBridge.adopt`'s copy is gone; `addPointer`
/ `listPointers` / `removePointer` record a name and absolute path against a
session id, `listPointers` renders only paths that still exist (true at read, a
gone directory drops), and `pointerRevision` moves on add/remove so a running
window's section is re-rendered and handed a delta of only the changed line.
`ArborHost.pointerArborProject` / `listArborPointers` / `removeArborPointer` /
`isAddedArborDirectory` expose it. Proof 8 proves the pointer is recorded without
a copy, is listed, drops when its directory is removed, and is never another
session's.

The pointer's prompt line lives in arbor's `<workspace>` section, one home beside
"where the window works", through `PromptSection.content(window)` with
`perWindow: true`: the implementation's own lines first, then the lead line, one
line per pointer, the reason and the consequence. The lead line is worded for
either workspace implementation — the ovnfs workspace has a shared folder the
pointer sits outside of and the plain-directory workspace has no shared folder at
all, so it states only what is true of both: the directory is the user's own, at
its original path, used directly.

**"Add workspace…" records the pointer with no new verb** (`@4fu/dsh-arbor-workspace`,
`DshProjectBridge`). The client's add-workspace action
(`@deepseek-ai/dsh-client-ui-workspace`, `WorkspacePickFlow.adoptDirectory`) calls
`createWorkspace({ path })` — the `workspace/create` remote verb — which is the
one caller of `WorkspaceRegistry.create` in a DSH installation besides this
bridge's own `sync`, and `sync` only ever names project subfolders of the shared
folder. So the bridge wraps `create` on the registry instance it is handed and
remembers every directory registered outside the shared folder as one the user
added; DSH's first-use default workspace is registered by
`WorkspaceRegistry.initializeDefault`, a different method that never reaches
`create`, so a cwd a session merely inherited is never mistaken for an added
directory. The driver then asks the host — at the two moments a session becomes
an arbor session, created under the preset or re-routed by a selection — whether
the directory it names was added, and records the pointer only then. Recording it
in `resolveProject`, which runs for every arbor session whatever cwd its caller
named, was tried and reverted: it recorded pointers for sessions that never asked
for one and broke proof 8. Proof 16 mounts a stand-in registry and proves the
whole chain.

The pointer is answered per window, and the attribution has to exist before the
window's prefix is frozen. Arbor's `windowStart` hook
(`@4fu/arbor-interfaces`, `Hooks`) runs before the `window_start` event is
appended and before the window's prompt epoch is rendered
(`@4fu/arbor-core`, `host.js`, `open`), and it carries the window together with
the task's targets — so the host records which session each window serves at the
one moment that is early enough. A window nothing attributes (one dispatched from
outside a DSH session) names no session, and an unnamed session has no pointers
rather than another session's.

**The picker filter, as built.** The decision stands — an ordinary session lists
nothing from arbor's shared folder, and an arbor session lists those projects
plus the directories the user added outside them, marked `（外部）` — and
`b3d` delivers it with `@4fu/dsh-arbor-ui-workspace`, a `dsh.client` package the
bundle inserts beside the shipped row. The seam is the registration itself, not
the seat, and the reasons the seat cannot be shadowed are unchanged:

- **Client.** `conversation.hero.workspace` is a `single` slot declared by
  `@deepseek-ai/dsh-client-ui-conversation` (`lib/client.js`, the `children`
  table) and occupied by `@deepseek-ai/dsh-client-ui-workspace`
  (`lib/client.js`, the `ctx.slots.inject("conversation.hero.workspace", ...)`
  registration), which declares the child
  `conversation.hero.workspace.directoryFlow`. The shipped `SlotCore.register`
  (in the frontend bundle, `dsh-web-frontend/dist/assets/index-*.js`) *does*
  allow a second registration on a `single` slot at a different priority — the
  refusal is for the same priority, and its own message says "register at a
  different priority to shadow it (lowest renders)" — but it refuses any child
  key that is already declared, so the occupant cannot carry the children table
  over. Registered without it, the occupant gets no `renderSlot` at all
  (`@deepseek-ai/dsh-client-ui-renderer`, `lib/client.js`: the kit only carries
  `renderSlot` when `entry.children !== undefined`, and `boundRenderSlot` throws
  `SlotOwnershipError` for a key the entry did not declare), the outlet reports
  the crash with `abdicate: true`, and the shipped occupant renders — the same
  trap as the permission seat, except that here carrying the declaration over is
  what throws. Nor can the store behind the list be replaced:
  `slots.provideRoot` refuses a duplicate hook name, so `useWorkspaces` cannot be
  wrapped at the root.
- **Server.** `WorkspaceRegistry.list()` / `get()` / `resolveByPath()` are
  process-global and take no session or caller
  (`@deepseek-ai/dsh-workspace`, `lib/types/index.d.ts`).
  `WorkspaceController.follow` filters only by `ctx.remoteAccess.allows({ kind,
  id })` (`@deepseek-ai/dsh-api-workspace-controller`, `lib/index.js`), and that
  decision's principal is a remote *peer* — the owner, or a non-owner kind with
  its own policy (`@deepseek-ai/dsh-api-remote-access`,
  `RemoteAccessRequest { principal, action, resources }`) — never a DSH session;
  DSH's web client holds one peer connection for every session it drives, so it
  cannot express "a session whose preset is arbor may". `create(request)` carries
  `{ path }` only (the typert host model,
  `packages/api/workspace-controller/src/index.ts`), and so do
  `directoryPicker/pick`, `list` and `createDirectory`.

So the filter wraps the registration. `ctx.slots` is one service instance shared
by every plugin in the page, so the package installs its own `register` on it as
an own property for as long as it is live and sees every registration that passes
through afterwards. The shipped plugin registers its seats through
`ctx.slots.inject(name, factory)` — a deferred registration whose callbacks run
after the whole boot has applied — so the hero-picker registration arrives
through the wrapper whatever order the rows activate in. The wrapper hands the
shipped component back with one thing changed: the same options, the same
children table, the same inject face and locale, and a `useWorkspaces` that
answers this composer's filtered view. Every other registration the shipped
plugin makes — `sidebar.workspaces`, the session row actions, the shell overlays,
the toasts — passes through untouched.

**Disabling the shipped row does not work, so the row stays enabled.** This is a
deviation from the patch as it was written up. The host serves the client module
graph from the composed plugin tree, so a row with `disabled: true` takes its
package out of the graph, and a `dsh.client.inject` dependency of the shipped
plugin then cannot arrive: the package fails to import ("require missed the
module table"). Re-running the shipped `apply` with the row enabled throws
`service "uiWorkspace" has been registered`. The wrapper alone, with the row
enabled, is the least invasive seam that works, and it is what ships.

**Which preset decides.** The hero seats are rendered without a session id — the
conversation's own hero row passes only `open`, `anchorRef`, `selectedId`,
`onPick` and `onClose` — so the session is read from the sessions store the way
DSH's own agent-preset plugin reads it (`@deepseek-ai/dsh-client-ui-agent-preset`,
`mainBlank`: the row the main view retains), and the preset comes from the
**bound** seat for that session (`heroInject(sessionId)`), with the unbound seat
and the `agentPreset` projection as fallbacks. Reading only the unbound seat
silently keeps `standard`; reading only the projection misses the staged pick.
The staged pick itself is resolved by polling
`slots.entriesOfSlot('conversation.hero.agentPreset')[0]?.inject`, bounded and
stopped on success, exactly as `@4fu/dsh-arbor-ui`'s sandbox gate reads it.

**The one thing the filter cannot know.** Which workspaces are arbor's is decided
by path: an arbor project's path carries the `arbor`/`shared` segments
(`DSH_HOME/arbor/shared/<project>`), and a workspace outside them is external. A
`dsh.client` package is offered no channel to the host's own answer —
`harness.handle`/`invoke` is the dynamic-plugin sandbox API and
`settings/describe` is credentials only — so the rule is a path convention rather
than a host answer. It is pinned by proof 18 together with the registration
shape.

**What is still unfiltered: the sidebar.** The same plugin also registers
`sidebar.workspaces` (`WorkspaceBrowser`), and its rows still list arbor's
projects for everyone. It is not a per-session surface — it is the app's
workspace/session tree — so there is no preset to key a filter on, and filtering
it by the main view's session would make the tree change as the user navigates.
The hero picker is the surface that chooses a session's project, and that is what
is filtered. A DSH deployment with no arbor at all is unaffected.

**The pin.** `proofs/18-picker-pin.ts` reads the shipped
`@deepseek-ai/dsh-client-ui-workspace` bundle and asserts the registration shape
(seat name, children table, inject face, locale, component), the pick flow's
`useWorkspaces((state) => state)` and its row fields (`workspaceId`, `title`,
`path`), the shipped service list against this package's own, the pinned DSH
version, and that the bundle patch does not disable the shipped row and does
insert this package. The wrapper is invisible when it silently stops matching, so
this is the test that fails instead.

**An ordinary composer with nothing left to list opens DSH's directory dialog.**
With every shared-folder project filtered out and no other workspace registered,
the picker's only entry is "Add workspace…", and DSH's own pick flow opens the
directory dialog directly in that case (`WorkspacePickFlow`: `addIsTheOnlyEntry`
→ `openDirectoryFlow()`). That is DSH's fresh-install behaviour, not something
this repository added, and it is the honest answer to an empty list: there is
nothing to pick, so DSH offers to add a directory. Once a directory is added it is
an ordinary DSH workspace like any other, listed to ordinary composers and
untouched by arbor.

**The pick the workspace switch drops, carried at create.** Adopting a directory
— or picking another project — re-uses the hero's blank session, and DSH's
`reuseLive` re-selects the resolved deployment default on it, because the
picker's adopt path (`createInWorkspace` → `createNamed`) names no preset. An
Arbor pick made a moment earlier is therefore followed back off arbor, which is
the one outcome the owner ruled out. The log cannot separate the two selections:
`presets.select` is the single writer of `agent-preset/selected`
(`@deepseek-ai/dsh-agent-preset-registry`, `lib/index.js`), so a
controller-issued re-select and a user's pick append the same event — which is
why the fix belongs in the surface that knows what the user clicked rather than
in the driver second-guessing an event it cannot attribute.

`b3e` re-committed the pick through the hero seat after the switch, which worked
and also proved where the fix belonged: DSH's own create can take the preset, so
no re-commit is needed. `b3f` supplies it at create — see
"The pick the workspace switch drops is carried at create" below — and the host
records no second `agent-preset/selected` at all.

**Where am I, where is my project: one line in `<workspace>`.** The live run on
`b3c` left the gap the owner named: the user picked `web-app` in the composer, the
window worked in its own directory, and the model answered "tell me the path" —
trial and error the prompt should have prevented. So the session's project is
stated once, inside arbor's own `<workspace>`, as
`当前项目 <name>：<path>` followed by the reach line the workspace
implementation's own:

```
当前项目 web-app：/home/…/arbor/shared/web-app
它在共享目录里，路径就是 /home/…/arbor/shared/web-app；本窗口另有自己的工作目录，按这个绝对路径直接读写该项目。
```

Under ovnfs the reach line is the checkout one instead — read the project in
place at its path or as `<name>/`, and open a checkout only for a change, whose
subdirectory is the project — because the two implementations get there
differently. The renderer resolves a line key that names a field, so the block
carries a `reach` field and the words stay in the text table; arbor's backend id
`dir` is mapped to arbor's own key `directory` (`REACH_OF` in
`packages/arbor-workspace/src/section.ts`). The ovnfs wording was corrected on
`b3g`: it used to promise `workspace.checkout("<project>")`, which arbor refuses,
and it said nothing about where relative paths start — see below.

Four details make the line true rather than merely present:

- **It names the session's project, not the header's.** The project is read from
  the session's *current* directory through DSH's `workingDirectory` projection
  (`ctx.sessionProjections.snapshot(session, ['workingDirectory'])`), because the
  header never moves and a session whose project was changed before its first
  turn would otherwise be named wrongly.
- **A re-routed session and one created under arbor agree.** Both resolve the
  picked directory the same way, so the cwd display, the project line and the
  model all read one answer. This is the asymmetry the re-route left behind: a
  created session was resolved into the shared folder, a re-routed one kept the
  directory it was created in.
- **A restart-recovered window is attributed to its session.** Arbor's recovery
  continues windows with no targets of their own, so the host rebuilds the
  window→session map from the journal *before* `host.start()`
  (`rebuildWindowSessions`), a `windowContinue` hook inherits the predecessor's
  session, and a recovered window whose agent is not back yet reads the stored
  session header cwd.
- **A project that moves reaches a running window as a delta of only the changed
  lines.** `workspaceRevision()` digests every live and recovered session's
  project, the section is `perWindow: true`, and the prefix is never rewritten.
  Proof 17 asserts the delta is exactly four lines — the two old ones removed, the
  two new ones added — with the implementation's own method lines untouched.

Proof 17 (`pnpm proof:project-section`) drives all of it, including the first
call going straight to the project's file with no exploratory call before it.

**ovnfs runs in the web profile when its binary is present.** The orb can mount
FUSE: `/dev/fuse` exists, `fuse3` 3.14.0 is installed, and the daemon starts.
With the real v0.1.1 binary on `PATH` — the same release arbor's own CI `ovnfs`
job installs, from `stencil-hq/ovnfs`, checksum-verified — the web profile reports
`workspaceBackend = ovnfs` and `mount` shows `fuse.ovnfs` on
`<DSH_HOME>/arbor/ovnfs/checkouts`. The mount is the checkouts directory, not the
shared folder, so projects can still be seeded into `<DSH_HOME>/arbor/shared`
after boot. Outside the profile, a checkout created with `ctl new` is readable and
writable through the mount and `ctl diff` / `ctl apply` merge it back into the
source. The live turn on that backend read the project line from `<workspace>`
and its **first** tool call was `ls -la <shared>/web-app`, straight to the project
the user picked, with arbor's own `bash`/`read`/`send`.

**The hero composer now stays live, and the pick is a create, not a re-route.**
This is the finding `b3e` left open, and it is closed on `b3f` by moving the
decision to where DSH's own create can take it.

The owner's option (a) — one routing handle per session that stays the agent DSH
binds to, deciding embedded or arbor at the first followup and delegating every
Agent method until then — cannot be built on dsh-v0.2.2-rc.1. Three lines of
source close it:

- `AgentRegistry.enter` refuses a second entry for one id —
  `if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)`
  (`@deepseek-ai/dsh-agent`, `lib/index.js`) — so the registered agent for a
  session id can only be replaced, never wrapped, and `prompt()` reaches the
  registered one (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`:
  `liveAgent` is `ctx.agents.get(sessionId)`).
- The only public way to remove that entry is `AgentHandle.dispose()`
  (`@deepseek-ai/dsh-agent`, `lib/types/index.d.ts`), which also removes the
  Session from the store — so a handle that disposed its inner agent would take
  the session with it, and the hero's `uiSession` binding would name a session
  that is gone.
- Neither inner factory can adopt a session that already exists: AgentLoop's
  `createAgent` and `resume` both call `sessions.prepare(id, …)`
  (`@deepseek-ai/dsh-agent-loop`, `lib/index.js`), and `SessionStore.prepare`
  throws `session "<id>" already exists` (`@deepseek-ai/dsh-session`,
  `lib/index.js`).

The Agent contract a handle would have to answer before it is decided is the
whole of it — `followup`, `whenIdle`, `cancel`, `status`, `session`, `ctx`,
`inbox`, `scope`, `model` (`@deepseek-ai/dsh-agent`, `lib/types/index.d.ts`) —
and the two facts above mean no object can hold both inner agents for one session
id at once. So the re-route must release the session, and the client sees it
leave and come back: the hero's session scope is materialized per session
*binding* through `ctx.uiSession.provide`
(`@deepseek-ai/dsh-client-ui-session`, `lib/client.js`), the re-route replaces
the binding owner, and the hero's `InputBar` computes
`live = input !== undefined && keyboard !== undefined && inputActions !== undefined`
(`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`) — false, for good.
Three public re-resolve paths were measured and none moves the main binding while
the session id is unchanged: `uiWorkspace.openSession(id)`, `clearMain()` +
`openSession(id)`, and `uiWorkspace.startSession(undefined, { agentPreset })`
(which reuses the same blank, because `createInWorkspace` matches it by cwd and
preset). A change of session id is the one thing that works.

So the pick became a create instead. `ArborAgentRegistry.create` routes on
`options.meta.agentPreset === 'arbor'`, and DSH's session controller builds that
meta from the composition it resolves **when the session is created**:
`createSession(request)` with no `sessionId` goes to
`createMinted(request.cwd, await this.composeAgent(request.agentPreset))`, and
`createAgent` passes `meta: { cwd, agentPreset }` to `ctx.agents.create`
(`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`). The client's own
`ISessions.create(opts?: { workspaceId?, cwd?, sessionId?, agentPreset? })`
(`@deepseek-ai/dsh-cordis-client-runner`, `lib/client.js`) is that same verb.

So `@4fu/dsh-arbor-ui` shadows the hero seat — `conversation.hero.agentPreset` is
a `single` slot with no children table
(`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`, the `children`
table: `kind: "single"`, `scope: "session-maybe"`), so a registration one
priority below the shipped occupant shadows it exactly the way the permission
seat is shadowed. The shadow carries the shipped component, locale and inject
face and wraps only the face's `select` — the hero chip's own commit
(`AgentPresetSeatInjected.select` → `AgentPresetSeatController.select` → `apply`
→ `ctx.remote.agentPresets.select`). When the main session is a blank with no
turn and the pick crosses the arbor boundary, the wrapper does **not** commit on
that blank: it creates a new session under the picked preset through the client's
own `sessions.create`, opens it through `uiWorkspace.openSession` — which changes
the hero's session id and therefore re-resolves its session scope, the one public
path that moves the main binding — carries the composer's draft across with the
same `conversation.input` shell API DSH's own workspace-switch carry uses
(`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`: `inputHub.shell`,
`draftSnapshot`, `setDraft`, `addAttachments`), and archives the blank it
replaces with the same call the session row's own archive action makes.

Both directions are minted, so Arbor back to Standard is a fresh embedded session
too — and the mint happens only where DSH's own create can hold it, a project of
the shared folder, so an ordinary composer's switch is byte-for-byte the shipped
call. The pick that does not cross the boundary, and a pick on a session that has
already started a turn, are handed straight to the shipped `select`: DSH's own
registry refuses a selection on a started session with `agent-preset/locked`
("This session has already started", `@deepseek-ai/dsh-agent-preset-registry`,
`lib/index.js`), so nothing is committed and nothing is silently kept. The
driver's own re-route stays as the fallback for the paths that never reach this
seat — an SDK or remote `agent-preset/select` on a blank — and it never fires on
the hero path, because that path writes no selection event at all. Proof 19
drives the host half of the create and asserts the header, the routing, the
absence of a selection event and the absence of a resume.

Two details of the gate were corrected in the same step, both in the direction of
"nothing untrue":

- **The staged pick decides only while the session has not started a turn.** A
  session that has started keeps the driver it began with, so on one the chip's
  staged pick is inert and only the committed `agentPreset` projection is true.
  Reading the staged pick there would take the sandbox switch away from an
  ordinary session — the same lie in the other direction.
- **The bound seat decides before the unbound one.** The seat bound to the
  composer's session answers first; the unbound seat — the chip before any
  session exists — is consulted only while the bound one has not loaded. An
  unbound store still naming a preset the bound session does not run would
  otherwise hide an ordinary session's switch.

**The pick the workspace switch drops is carried at create.** DSH's picker adopt
path names no preset — the hero's `onPick` is
`selectWorkspace(workspaceId)` → `workspaceNavigation.openWorkspace(workspaceId,
beforeOpen)` with no options bag (`@deepseek-ai/dsh-client-ui-conversation`,
`lib/client.js`) — and `openWorkspace` → `connectBlank` → `createInWorkspace`
forwards `options.agentPreset` to `sessions.create` when it is given
(`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`: `createInWorkspace`
spreads `...options.agentPreset === void 0 ? {} : { agentPreset }`). So the only
missing piece was the option, and `@4fu/dsh-arbor-ui-workspace` supplies it by
wrapping `uiWorkspace.openWorkspace` on the service instance: one method, filled
in only when the caller gave none and the composer's pick is Arbor. Everything
else about the shipped path is untouched — the same blank-reuse rules, the same
draft carry in `beforeOpen`, the same `startSession` calls that already name a
preset — and an ordinary composer's switch is byte-for-byte the shipped call.

**Where the create cannot take it: a directory outside the shared folder.** An
arbor session always works in arbor's own directory, so
`DshProjectBridge.resolveProject` answers a directory outside the shared folder
with the shared folder itself (`packages/arbor-workspace/src/projects.ts`). A
session created under arbor for such a directory therefore has a cwd the
workspace attach refuses — `session/workspace-attach-failed`, "its cwd resolves
to …".

`b3f` left that case on the `b3e` path — the shipped adopt, then a re-commit
through the hero seat — and the live run showed what it costs: the adopt switches
the main session to a blank in the added workspace, the re-route then moves that
session's cwd to the shared folder, and DSH filters a workspace's member list by
the session's stored cwd (`@deepseek-ai/dsh-workspace`,
`WorkspaceEntity.sessionIds` → `candidateMatches`), so the session reads as a
member of nowhere. The hero composer answers
`chipTitle === undefined` and renders inert
(`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`:
`inert = sessionId === void 0 || hero && chipTitle === void 0`) — the dead
composer, reproduced live on `b3g` before the fix.

**`b3h` answers it with DSH's own membership rule, and the session belongs where
the user picked.** A workspace's `sessionIds` are filtered by the session's
stored cwd (`@deepseek-ai/dsh-workspace`, `WorkspaceEntity.sessionIds` ->
`candidateMatches` -> `sessionPaths.get(id) === path`), and
`Workspace.attachSession` refuses a session whose cwd is not the workspace's
path ("its cwd resolves to …"). So a session belongs to exactly one workspace:
the one whose path is its cwd. That is the whole answer to "where does an arbor
session with no project, or with only an external pointer, belong" — the
directory the user picked — and it is reachable only if the session's cwd is
that directory. `b3g` had moved every outside cwd into the shared folder and
then registered the shared folder as a workspace to give the session a home,
which put it under a row named "shared": arbor's internal folder, not a project
the user made, with the added directory beside it as an empty workspace.

So on `b3h` `DshProjectBridge.resolveProject` answers the requested directory
as-is. A project of the shared folder is a project; a directory the user added
outside it is that directory; DSH's own default workspace is itself. The
outside-directory add therefore runs the shipped adopt with the pick in it
(`sessions.create({ workspaceId, agentPreset: 'arbor' })` through
`createInWorkspace`), which is the create that records the pointer
(`ArborDriver.createArborAgent` reads the requested cwd, asks the host whether
the user added it, and records it) and attaches the session to that workspace,
so the sidebar shows the session under the row the user picked. The registry
`create` has already happened by then — the shipped add-workspace flow is
`createWorkspace({ path })` then `onPick(workspace.workspaceId)`
(`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`, `adoptDirectory`).

**The shared folder is never a DSH workspace.** `attachWorkspace` refuses it, so
no row names arbor's internal folder. A project subfolder is registered the way
`sync` registers one, so a project a window made with `mkdir` is a workspace the
session can belong to; a directory outside the shared folder is attached to only
when DSH's list already has it, which is the case for every directory a user
added through DSH's own add-workspace action. Proof 21 mounts a stand-in
registry that enforces DSH's membership rule and proves all of it.

**What the cwd rule used to buy, and what replaces it.** b3c moved an arbor
session's cwd into the shared folder so that "the DSH session, its cwd display
and the project picker all name a folder that is really there". With the cwd
answered as-is they still do — the folder is the one the user picked — and the
window still works in arbor's own directory under `DSH_HOME/arbor`, reading the
shared folder through ovnfs and opening checkouts in it. The session's cwd is a
DSH-side fact (the cwd display, the project line, the workspace membership);
arbor's prompt says where the window works in its own words, so the two never
contradict each other. What is lost is the case where a session inherited a cwd
nobody picked: it now keeps that directory, and `<workspace>` names no project
for it, which is the b3c gap rather than a lie.

**The sidebar browser is marked, not filtered.** The same registration wrapper
reaches `sidebar.workspaces`, which the shipped plugin registers through the same
deferred `ctx.slots.inject`. The sidebar lists every workspace for every
session, so there is no composer preset to key a filter on — filtering there
would hide arbor's projects from a user working in one. So arbor's rows carry
`（Arbor）` in the sidebar instead: an ordinary user can see which rows an
ordinary session cannot use.

**The reload finding of `b3h`, corrected, and closed on both sides.** `b3h`
reported that a plain reload turns an Arbor session into a Standard one. On this
tree it does not: an instrumented web-profile probe that picks Arbor in the
hero, adds an outside directory, and then reloads the page twice — once with the
arbor session in a shared-folder project and once in the added directory — and
then relaunches the browser, keeps Arbor on the hero with no sandbox switch, and
the host log records no `agent-preset/selected` at all. The mechanism the `b3h`
note described is real in DSH's source, and it is what this step closes; the
event it observed in that run came from something other than the reload (the
`b3h` flow clip shows the preset dropdown being opened and hovered in the middle
of the add-workspace flow, which is a selection, not a restore).

The chain, and the two halves that close it:

- **The client half.** A cold page load restores the saved blank through
  `restoreBlank` (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`),
  which awaits `sessions.refreshProjections(sessionId)` and then reads
  `byId[sessionId]?.projectionValues?.agentPreset`, passing it at create when it
  is a string. The projection is initialized from the session header's
  `agentPreset` (`@deepseek-ai/dsh-agent-preset-registry`, `lib/index.js`:
  `init: (header) => header.agentPreset ?? null`), so the fact is there — but the
  key declares no `wire.summary` (`lib/types/session.js`), so the session list's
  projection blocks never fill it and the Host's own projections read is the only
  thing that does. That read is one attempt: when it answers before the session's
  row is visible to the Host, or fails, the cache stays cold, the create names no
  preset, `composeAgent(undefined)` resolves the configured default, and
  `reuseLive` applies it because `target !== current`. `@4fu/dsh-arbor-ui-workspace`
  therefore wraps `restoreBlank` on the service instance and holds the call until
  the session's own answer is in the cache, against a bounded deadline — the
  request itself is still DSH's, made by DSH's own method. Proof 22 drives the
  shipped plugin's own `apply` against a client that behaves exactly as the
  shipped code does, and asserts both halves: the shipped restore names no preset
  while its cache is cold, and the wrapped one names arbor.
- **The host half.** The driver never reverse-routes a session whose creation
  header says `agentPreset: 'arbor'`; see "A switch before the first turn" above.
  The residual the client cannot close is a restore that goes out before the
  session's answer arrives and a read the cache never holds, and the gate is what
  stands behind it: the session keeps arbor and its label is re-asserted, so
  neither the driver nor the projection says something untrue.

That replaces the `b3e` fix for the shared folder's projects, where the re-commit
is what made DSH's own `reuseLive`
(`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) follow the pick back
off arbor and the driver re-route the session under a live binding. With the pick
in the create there is nothing to follow back, and the host records no second
`agent-preset/selected` at all.

**The ovnfs reach line says where relative paths start, and that reading in place
is fine.** The `b3f` Trajectory showed the gap: the first bash ran
`cd web-app && ls -la`, relying on the shell starting in the shared folder, and
the model then listed the sibling project as noise. Arbor's own ovnfs lines
already say the shared folder is where every window reads from and where bash runs
(`workspace.method.shared`) and that a change goes through a checkout
(`workspace.method.open`, `workspace.method.readonly`), so the reach line adds
only the project's own half — that it is a subdirectory of that same place,
reachable at the absolute path the line names or as `<name>/`, with no `cd` and
no checkout for reading:

```
它在共享目录里，子目录是 web-app：读它就读 /home/…/arbor/shared/web-app，或按 web-app/ 读，不用开检出、不用 cd；要改它就用 workspace.checkout 给它开检出（子目录填 web-app），改完用 workspace.apply 合回共享目录。
```

The `b3d` wording promised `workspace.checkout("web-app")`, which arbor refuses:
a checkout name must start with the window's own reference and the project
subdirectory is the second argument (`@4fu/arbor-workspace-ovnfs`, `groups.js`,
`checkout` → `refused.workspace.name`). The line now names the subdirectory as
the argument instead. Proof 20 runs on the ovnfs backend and proves the line, the
refusal-free call shape and a first call that reads the project at the path the
line names with no `cd` and no call reaching a sibling project.

## What arbor's core still lacks (back to the arbor repo)

5. **A shadowable seat with a children table.** `SlotCore.register` refuses a
   second declaration of an already-declared child key, so any `single` slot whose
   occupant declares children (the hero workspace picker, the sidebar browser)
   cannot be shadowed at all. A registration without the children table leaves the
   occupant without `renderSlot`, which abdicates it. Shadowing such a seat needs
   either a children-table override or a documented way to inherit one. This
   deployment no longer waits on it for the hero picker — `@4fu/dsh-arbor-ui-workspace`
   wraps the registration instead — but the sidebar browser
   (`sidebar.workspaces`) is still unshadowed and unfiltered, and a children-table
   override is what would let a package filter it.

6. **`Workspace.reclaimable?()`** — the interface assumes an implementation owns
   a directory it can remove. A workspace whose source is the user's shared
   folder would answer `false` and never reclaim. The arbor docs already describe
   it (`docs/workspaces.md#lifecycle`); it would let this deployment state that
   the shared folder is not its own to delete. Not needed yet: no retention is
   set, so nothing is reclaimed.
7. **`PromptSection.content(window)` with `perWindow: true`** — landed in arbor
   2026.1107.1 and used here: the external-project pointers render inside
   arbor's own `<workspace>`, answered for the window the section is rendered
   for, and reach a running window as a delta of only the changed lines. What it
   still does not offer is a way to name the session a window serves: arbor's
   `WindowRef` (`c1`, `c2`, ...) carries no session identity, which is why this
   deployment attributes windows through its own `windowStart` hook.
8. **The judge is still off**, and with it the routing policy: one window per
   session, opened on the session's first turn.
9. **`models()` / `login()` are still placeholders**; the window's model comes
   from the DSH session's model selection.
