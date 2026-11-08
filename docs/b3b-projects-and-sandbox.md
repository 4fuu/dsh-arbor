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
`dsh-v0.2.2-rc.1`; arbor is `2026.1107.0`.

## The mechanism table

Every DSH mechanism this step touches, what an arbor session does with it, and
where it lives in DSH. "Removed" means the mechanism no longer governs an arbor
session; "kept" means it still does.

| DSH mechanism | Arbor sessions | DSH source location |
| --- | --- | --- |
| **Projects** (`Workspace` registry) | Arbor's shared folder is the source of truth. A DSH project is a project subfolder of the shared folder, registered in the registry so the UI lists it. | `@deepseek-ai/dsh-workspace` (`WorkspaceRegistry`, `Workspace`, `ctx.workspaceRegistry`); served by `@deepseek-ai/dsh-api-workspace-controller` |
| **Project list / picker / creation** (client) | Reads arbor's projects because the client reads the registry the bridge fills. **Decision (item 2): ordinary sessions do not see arbor's shared-folder projects** — an ordinary session's cwd inside the shared folder would put the embedded AgentLoop's sandboxed tools writing into ovnfs's source (read-only by convention, written only by `apply`), which would either fail or corrupt arbor's model, and ordinary sessions must not change. The registry is process-global, so this is a client filter that hides shared-folder projects for a non-arbor preset; it is the remaining client work (the filter needs the shared-folder path). | `@deepseek-ai/dsh-client-ui-workspace` (`WorkspacePicker`, `WorkspaceBrowser`); `@deepseek-ai/dsh-api-workspace-controller` (`WorkspaceView`); the registry `ctx.workspaceRegistry` in `@deepseek-ai/dsh-workspace` |
| **Session cwd** (`working-directory:current`) | Not bound to one cwd. The session's cwd is the shared folder; a window works in its ovnfs checkout of whichever project it needs, and `<workspace>` names the shared folder. | `@deepseek-ai/dsh-working-directory` (`WorkingDirectoryService`, `working-directory/change`); prompt section `working-directory:current` |
| **Sandbox modes** (`sandbox/mode`, policy) | Removed. Arbor's file tools run on the host; no mode is resolved for an arbor window and no `sandbox/mode` event is emitted for it. | `@deepseek-ai/dsh-sandbox-policy` (`SandboxPolicyService`, `ctx.sandboxPolicy`, `sandboxMode` projection); `@deepseek-ai/dsh-sandbox` (`SandboxMode`) |
| **Sandbox enforcement** (`ctx.fs`, `ctx.shell`) | Not used by arbor's tools. They reach files through arbor's own workspace (`node:fs`, `spawn('/bin/sh')` on the host), exactly as in standalone arbor. The sandbox rows stay mounted for ordinary sessions. | `@deepseek-ai/dsh-fs-sandbox` (`SandboxedFileSystem`); `@deepseek-ai/dsh-bash-sandbox` (`SandboxBashExecutor`); `@deepseek-ai/dsh-sandbox-local` |
| **Escalation** (`sandbox_escalate`, `approveEscalation`, `sandbox_permissions`) | Removed. There is no escalation tool and no per-call permission argument to widen; nothing a window does is confined, so there is nothing to widen. | `@deepseek-ai/dsh-sandbox` (`escalation.d.ts`, `approveEscalation`, `ESCALATION_TARGETS`); `@deepseek-ai/dsh-tool-fs` / `dsh-tool-bash` |
| **Tool approval** (`approval:policy`, `ctx.approval`) | **Kept.** It is separate from the sandbox: a tool call that needs approval still routes through DSH's approval on the user session's agent, and arbor's tools run through `ctx.tools.execute` the same way. | `@deepseek-ai/dsh-user-approval` (`ctx.approval`, `approval/request`); `@deepseek-ai/dsh-tools` (`pipeline.ts`, `serviceAsk`) |
| **Sandbox mode switch** (client) | Hidden for arbor sessions. `@4fu/dsh-arbor-ui` shadows the `conversation.input.permission` `single` slot one priority below `@deepseek-ai/dsh-client-ui-permission-presets`' occupant and renders the real control for an ordinary session, nothing for an arbor one (whose `useProjection("agentPreset")` is `"arbor"`). The switch is gone from an arbor composer; an ordinary composer keeps it byte-for-byte. | `@deepseek-ai/dsh-client-ui-permission-presets` (`PermissionSelect`, seat `conversation.input.permission`); `@deepseek-ai/dsh-client-ui-conversation` (the `single` slot, `entriesOfSlot`); the preset projection `agentPreset` in `@deepseek-ai/dsh-agent-preset-registry` |
| **cwd display** (client) | Unchanged and honest: the session's cwd *is* the arbor shared folder, so the display names a real directory. No client change is needed. | `@deepseek-ai/dsh-client-ui-workspace` (session header cwd, `path-suffix`) |
| **External-project pointer** (prompt) | An existing directory with its own path is recorded as a pointer (name + absolute path), never copied, linked, adopted or registered as a project. It is named in arbor's prompt so the model reaches it on the host directly. Recording it inside arbor's `<workspace>` section is gated on arbor's coming `PromptSection.content(window)` with `perWindow: true` (see the UI half below). | `@4fu/dsh-arbor-workspace` (`DshProjectBridge.addPointer`/`listPointers`/`removePointer`); arbor's `<workspace>` section from `@4fu/arbor-prompt` / arbor-core |
| **Add workspace…** (client) | For an arbor session it should record a pointer rather than register an arbitrary path as a project. The host API is ready (`ArborHost.pointerArborProject`); the client action that calls it is the remaining client wiring. | `@deepseek-ai/dsh-client-ui-workspace` (the add-workspace action); `@deepseek-ai/dsh-api-workspace-controller` (`WorkspaceView`) |
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
3. **An existing DSH project with its own path joins the shared folder by
   explicit adoption, not silently.** `DshProjectBridge.adopt(path)` copies the
   directory once into a same-named project subfolder (idempotent; the original
   is untouched), and it is invoked deliberately — by the UI's
   add-existing-project action or by the model. A session is never pointed at a
   silent copy of an arbitrary directory the caller happened to name as its cwd;
   `resolveProject` answers the shared folder for a directory outside it. Copying
   is what lets ovnfs check the project out, because ovnfs checks out only a
   subfolder of its source.
4. **The sandbox is gone for arbor sessions, and so is its escalation.** No mode
   is resolved, no `sandbox/mode` event is emitted, no escalation tool exists,
   and arbor's file tools run on the host. DSH's tool approval is kept — it is a
   separate mechanism and stays.
5. **Ordinary sessions are untouched.** The routing registry still sends every
   non-arbor session to the embedded AgentLoop; the sandbox rows stay mounted and
   their file policy still applies to those sessions' tools. Proof 8 asserts an
   ordinary session keeps its cwd and that `ctx.sandboxPolicy` is still present.

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

**A routing finding the owner must decide on.** Selecting Arbor in the hero does
not make the session run arbor. `ArborAgentRegistry.create` routes on
`options.meta.agentPreset === 'arbor'`, and DSH's session controller builds that
meta from the composition it resolves **when the session is created**
(`@deepseek-ai/dsh-api-session-controller`, `createAgent`); the hero chip's later
`agent-preset/selected` only advances the projection (`reuseLive` calls
`presets.select` and returns the same live agent). Verified live: a session whose
hero pick is Arbor ran the embedded AgentLoop's own `working_directory` tool and
left the arbor journal empty. So the composer now stops offering a sandbox mode
as soon as Arbor is picked, while the session underneath still runs the embedded
loop — the UI follows the pick, not the running composition. Making the pick
actually route needs a surface that passes the staged preset into session
creation (`sessions.create({ agentPreset })`), which no DSH surface does today;
see "what arbor's core still lacks".

**The external-project pointer is recorded, not copied** (`@4fu/dsh-arbor-workspace`).
`DshProjectBridge.adopt`'s copy is gone; `addPointer` / `listPointers` /
`removePointer` record a name and absolute path, `listPointers` renders only
paths that still exist (true at read, a gone directory drops), and
`pointerRevision` moves on add/remove so a running window's section is re-rendered
and handed a delta of only the changed line. `ArborHost.pointerArborProject` /
`listArborPointers` / `removeArborPointer` expose it. Proof 8 proves the pointer
is recorded without a copy, is listed, and drops when its directory is removed.

The pointer's prompt line belongs in arbor's `<workspace>` section, one home
beside "where the window works". Arbor's `<workspace>` is a **fixed** section
built by arbor-core from the workspace; a plugin's `promptSection` renders in a
tag named after the plugin (`<harness>`, `<dsh>`), so a plugin cannot contribute
to `<workspace>` today. Putting the pointer inside `<workspace>` — rather than as
a second line in the bridge's `<harness>`, which the owner's "one home" forbids —
is gated on arbor's coming `PromptSection.content(window)` with `perWindow: true`
(see below), which is exactly the seam that would let a per-session section be
exact. Until it lands, the pointer is recorded and proven server-side, and its
rendering is the one remaining step of this feature.

**The remaining client work is blocked, both pieces, on seams DSH does not
offer.** They belong in the same `@4fu/dsh-arbor-ui` package B4 grows; the host
APIs they call are already in place and proven.

- **The project-picker filter** (hide shared-folder projects for a non-arbor
  preset — item 2's decision) needs the picker seat shadowed, and it cannot be.
  `conversation.hero.workspace` declares a child slot
  (`conversation.hero.workspace.directoryFlow`), and `SlotCore.register` refuses
  a second declaration of a child key that is already declared
  (`@deepseek-ai/dsh-client-ui-slots`, `lib/index.js`: `slot "<child>" is already
  declared`). Registering without the children table leaves the occupant with no
  `renderSlot`, so the shipped `WorkspacePicker` throws on its own directory flow
  and abdicates — the same trap as above, and it cannot be repaired by carrying
  the declaration over, because carrying it over is what throws.
- **Wiring "Add workspace…" to `pointerArborProject`** needs a browser-to-host
  call, and dsh-arbor has none. DSH's browser-to-host verbs are the typert remote
  namespaces (`ctx.remote.*`), each generated by DSH's own compiler from a
  `TypertRemoteService`; adding one here is not possible without that toolchain.
  The remaining channels were checked and ruled out: the forwarded-event
  allowlist is a fixed list in `@deepseek-ai/dsh-api-remotes`
  (`API_REMOTE_FORWARDED_EVENTS`), the arbor host's Config is not exposed through
  `ctx.remote.settings.describe()`, and recording the pointer inside
  `DshProjectBridge.resolveProject` was tried and reverted — that runs for every
  arbor session whatever cwd its caller named, so it recorded pointers for
  sessions that never asked for one and broke proof 8.

## What arbor's core still lacks (back to the arbor repo)

4. **A surface that starts an arbor session.** DSH routes a session to arbor from
   `meta.agentPreset` at agent creation, and the hero chip's pick arrives after
   the agent exists, so the web client cannot start one. The fix is a surface that
   passes the staged preset into `sessions.create({ agentPreset })` — the TUI, or
   a `dsh.client` package that wraps the hero's workspace connection. Until then
   the arbor preset is reachable only through the SDK path the proofs use.
5. **A shadowable seat with a children table.** `SlotCore.register` refuses a
   second declaration of an already-declared child key, so any `single` slot whose
   occupant declares children (the hero workspace picker, the sidebar browser)
   cannot be shadowed at all. A registration without the children table leaves the
   occupant without `renderSlot`, which abdicates it. Shadowing such a seat needs
   either a children-table override or a documented way to inherit one.
6. **A browser-to-host verb dsh-arbor can add.** The typert remote namespaces are
   compiler-generated inside DSH's monorepo; the forwarded-event allowlist is a
   fixed list. A dsh-arbor action (record an external pointer) therefore has no
   way to reach the host from the browser today.

1. **`Workspace.reclaimable?()`** — the interface assumes an implementation owns
   a directory it can remove. A workspace whose source is the user's shared
   folder would answer `false` and never reclaim. The arbor docs already describe
   it (`docs/workspaces.md#lifecycle`); it would let this deployment state that
   the shared folder is not its own to delete. Not needed yet: no retention is
   set, so nothing is reclaimed.
2. **`PromptSection.content(window)` with `perWindow: true`** — a host-level
   section is registered once per process and rendered per window, so a
   per-session section has to be declared per window. It is the seam the
   external-project pointer needs: arbor's `<workspace>` is a fixed arbor-core
   section a plugin cannot contribute to, so the pointer (a per-session fact that
   must reach a running window as a delta) cannot live inside `<workspace>` until
   a plugin section can be per-window and exact. The ovnfs section is per-host
   here (one shared folder), so it is already exact; the gap shows for a section
   that must differ per session — the pointer, and any arbor-vs-ordinary
   difference in one process.
3. **The judge is still off**, and with it the routing policy: one window per
   session, opened on the session's first turn.
4. **`models()` / `login()` are still placeholders**; the window's model comes
   from the DSH session's model selection.
