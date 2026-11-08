# B3b findings: arbor takes over DSH's projects, and the sandbox goes away

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
`dsh-v0.2.2-rc.1`; arbor is `2026.1107.1`.

## The mechanism table

Every DSH mechanism this step touches, what an arbor session does with it, and
where it lives in DSH. "Removed" means the mechanism no longer governs an arbor
session; "kept" means it still does.

| DSH mechanism | Arbor sessions | DSH source location |
| --- | --- | --- |
| **Projects** (`Workspace` registry) | Arbor's shared folder is the source of truth. A DSH project is a project subfolder of the shared folder, registered in the registry so the UI lists it. | `@deepseek-ai/dsh-workspace` (`WorkspaceRegistry`, `Workspace`, `ctx.workspaceRegistry`); served by `@deepseek-ai/dsh-api-workspace-controller` |
| **Project list / picker / creation** (client) | Reads arbor's projects because the client reads the registry the bridge fills. **Decision (item 2): ordinary sessions do not see arbor's shared-folder projects** — an ordinary session's cwd inside the shared folder would put the embedded AgentLoop's sandboxed tools writing into ovnfs's source (read-only by convention, written only by `apply`), which would either fail or corrupt arbor's model, and ordinary sessions must not change. **Not achievable in dsh-v0.2.2-rc.1**: neither the client nor the server has a per-session view of the workspace list, and the preset the filter would key on exists only in the browser. See "The picker filter, precisely" below. | `@deepseek-ai/dsh-client-ui-workspace` (`WorkspacePicker`, `WorkspaceBrowser`); `@deepseek-ai/dsh-api-workspace-controller` (`WorkspaceView`); the registry `ctx.workspaceRegistry` in `@deepseek-ai/dsh-workspace` |
| **Add workspace…** (client) | Records a pointer for the arbor session that asked, with no new verb and no client change. The action reaches `WorkspaceRegistry.create`, the bridge hooks it, and the driver asks at the two moments a session becomes an arbor session whether the directory it names was added. | `@deepseek-ai/dsh-api-workspace-controller` (`create`, the `workspace/create` verb — the one caller of `WorkspaceRegistry.create` besides this bridge's own sync); `WorkspaceRegistry.initializeDefault` (the first-use default, a different method, so an inherited cwd is never an added directory) |
| **External-project pointer** (prompt) | An existing directory with its own path is recorded as a pointer (name + absolute path), never copied, linked, adopted or registered as a project. It is named in arbor's prompt so the model reaches it on the host directly. Recorded **per session**, and rendered inside arbor's `<workspace>` through `PromptSection.content(window)` with `perWindow: true`. | `@4fu/dsh-arbor-workspace` (`DshProjectBridge.addPointer`/`listPointers`/`removePointer`/`isAddedDirectory`); arbor's `<workspace>` section from `@4fu/arbor-prompt` / arbor-core; the `windowStart` hook in `@4fu/arbor-interfaces` (`Hooks`) |
| **Preset selection** (`agent-preset/selected`) | Committed by DSH's own registry and observed by the driver: a blank session that selects arbor is re-routed from the embedded loop to arbor, keeping its identity and its log. A selection after the first turn is refused by DSH with a visible reason. | `@deepseek-ai/dsh-agent-preset-registry` (`select`, `agent-preset/locked`); `@deepseek-ai/dsh-api-session-controller` (`createAgent` builds `meta.agentPreset` at creation); `@deepseek-ai/dsh-client-ui-agent-preset` (`AgentPresetSeatController.select`/`apply` → `ctx.remote.agentPresets.select`) |
| **Session cwd** (`working-directory:current`) | Not bound to one cwd. The session's cwd is the shared folder; a window works in its ovnfs checkout of whichever project it needs, and `<workspace>` names the shared folder. | `@deepseek-ai/dsh-working-directory` (`WorkingDirectoryService`, `working-directory/change`); prompt section `working-directory:current` |
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
2. **An arbor session is not bound to one cwd.** The driver sets the session's
   cwd to the shared folder; a window opens a checkout of the project subfolder
   it needs. `<workspace>` names the shared folder and the checkout method.
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

**Picking Arbor in the hero now runs arbor** (this is the finding the previous
revision of this page left open, and it is fixed). `ArborAgentRegistry.create`
routes on `options.meta.agentPreset === 'arbor'`, and DSH's session controller
builds that meta from the composition it resolves **when the session is
created** (`@deepseek-ai/dsh-api-session-controller`, `createAgent`), so a hero's
blank session — created with no preset, because the chip's pick is staged before
the session exists — started on the embedded loop and stayed there: the chip's
later pick only advanced the projection.

The fix uses DSH's own event rather than a new surface. The hero chip
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

**A switch after the first turn is refused, not silently kept.** DSH's own
registry refuses a selection on a session that has started a turn with
`agent-preset/locked` — "This session has already started" — so the hero chip
shows that reason as its own refusal and the session keeps the driver it began
with, visibly. The driver guards on the turn boundary as well, because the one
outcome that is untrue to the user is a session that answers as arbor while
running the embedded loop (or the reverse) with nothing said. Proof 15 drives
the controller's own path and asserts both halves.

**A switch before the first turn is followed, in both directions.** The event
carries the other direction too, and honouring it is what the web profile needs:
DSH's session controller re-selects the resolved default preset whenever a blank
session is reused (`@deepseek-ai/dsh-api-session-controller`, `reuseLive` calls
`presets.select` with `composition.agentPreset`, and `composeAgent(undefined)`
resolves the deployment default), so an arbor session the user reopens in another
workspace is relabelled `standard`. The driver therefore re-routes a blank arbor
session that selects any other preset back onto the embedded loop — ending the
arbor agent with the teardown this driver holds, leaving the window to arbor's own
idle policy, and opening the same session id on the embedded loop with the same
log and the same cwd. Verified live: a session whose hero pick is Arbor runs
arbor (its `bash`/`read` calls land in arbor's journal and its `<workspace>` is
arbor's own), an ordinary session in the same process keeps DSH's
`working_directory` tool and its sandbox switch, and a session the picker reuses
comes back on the loop its log names.

`ownsSession` now folds the log's `agent-preset/selected` events over the
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

**The picker filter: neither the client nor the server can do it.** The decision
stands — ordinary sessions should not list arbor's shared-folder projects — but
dsh-v0.2.2-rc.1 offers no seam for it on either side, and the reason is precise:

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
  wrapped.
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

The smallest pinned patch that would deliver it, for the owner to decide on
because it disables a DSH row and re-mounts it through this repository:

1. `- id: ui-workspace` / `disabled: true` in the bundle patch, plus
   `- insert: [{ id: arbor-ui-workspace, name: '@4fu/dsh-arbor-ui/workspace' }]`.
2. The new client plugin imports the shipped one's `apply`/`inject` from
   `@deepseek-ai/dsh-client-ui-workspace` (its `dsh.client.inject` lists it, so
   the module graph resolves it), and calls it with `ctx.slots.register` wrapped
   for the duration of that one call: the `conversation.hero.workspace`
   registration is replaced by this package's own — same options, children table
   included, so the directory flow still renders — whose component reads the
   shipped occupant from `entriesOfSlot`, wraps its `useWorkspaces` in a hook
   that drops shared-folder workspaces while the composer's staged preset is not
   arbor (the staged pick is read exactly as `@4fu/dsh-arbor-ui`'s gate reads
   it), and renders the shipped component with the filtered hook. Every other
   registration the shipped plugin makes passes through untouched.

That is roughly forty lines plus one row pair, and it is a decision rather than
a fix: it makes this repository responsible for DSH's whole workspace client
surface, and the wrapper is invisible when it silently stops matching. The
alternative — wait for a shadowable seat with a children-table override in
arbor's core, or a per-session workspace view in DSH — is listed below.

## What arbor's core still lacks (back to the arbor repo)

5. **A shadowable seat with a children table.** `SlotCore.register` refuses a
   second declaration of an already-declared child key, so any `single` slot whose
   occupant declares children (the hero workspace picker, the sidebar browser)
   cannot be shadowed at all. A registration without the children table leaves the
   occupant without `renderSlot`, which abdicates it. Shadowing such a seat needs
   either a children-table override or a documented way to inherit one — the
   project-picker filter is waiting on exactly this.

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
