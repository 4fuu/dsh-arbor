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
| **Project list / picker / creation** (client) | Reflects arbor's projects, because the client reads the registry the bridge fills. Scoping the list to arbor sessions in the picker is a client concern (the later UI stage). | `@deepseek-ai/dsh-client-ui-workspace` (`WorkspacePicker`, `WorkspaceBrowser`); `@deepseek-ai/dsh-api-workspace-controller` (`WorkspaceView`) |
| **Session cwd** (`working-directory:current`) | Not bound to one cwd. The session's cwd is the shared folder; a window works in its ovnfs checkout of whichever project it needs, and `<workspace>` names the shared folder. | `@deepseek-ai/dsh-working-directory` (`WorkingDirectoryService`, `working-directory/change`); prompt section `working-directory:current` |
| **Sandbox modes** (`sandbox/mode`, policy) | Removed. Arbor's file tools run on the host; no mode is resolved for an arbor window and no `sandbox/mode` event is emitted for it. | `@deepseek-ai/dsh-sandbox-policy` (`SandboxPolicyService`, `ctx.sandboxPolicy`, `sandboxMode` projection); `@deepseek-ai/dsh-sandbox` (`SandboxMode`) |
| **Sandbox enforcement** (`ctx.fs`, `ctx.shell`) | Not used by arbor's tools. They reach files through arbor's own workspace (`node:fs`, `spawn('/bin/sh')` on the host), exactly as in standalone arbor. The sandbox rows stay mounted for ordinary sessions. | `@deepseek-ai/dsh-fs-sandbox` (`SandboxedFileSystem`); `@deepseek-ai/dsh-bash-sandbox` (`SandboxBashExecutor`); `@deepseek-ai/dsh-sandbox-local` |
| **Escalation** (`sandbox_escalate`, `approveEscalation`, `sandbox_permissions`) | Removed. There is no escalation tool and no per-call permission argument to widen; nothing a window does is confined, so there is nothing to widen. | `@deepseek-ai/dsh-sandbox` (`escalation.d.ts`, `approveEscalation`, `ESCALATION_TARGETS`); `@deepseek-ai/dsh-tool-fs` / `dsh-tool-bash` |
| **Tool approval** (`approval:policy`, `ctx.approval`) | **Kept.** It is separate from the sandbox: a tool call that needs approval still routes through DSH's approval on the user session's agent, and arbor's tools run through `ctx.tools.execute` the same way. | `@deepseek-ai/dsh-user-approval` (`ctx.approval`, `approval/request`); `@deepseek-ai/dsh-tools` (`pipeline.ts`, `serviceAsk`) |
| **Sandbox mode switch** (client) | Hidden for arbor sessions: there is no sandbox mode to switch. The server emits no `sandbox/mode` for an arbor session; the client switch is the remaining client-side item (see UI below). | `@deepseek-ai/dsh-client-ui-permission-presets` |
| **cwd display** (client) | Replaced with what is true: the arbor shared folder. The session's cwd *is* the shared folder, so the display is honest without a client change. | `@deepseek-ai/dsh-client-ui-workspace` (`path-suffix`, session header cwd) |
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

The DSH web client ships as compiled browser bundles (`lib/client.js` in each
`@deepseek-ai/dsh-client-ui-*`), so it cannot be patched in a way that survives a
clean `pnpm install`. The clean extension point is a `dsh.client` plugin module
(the full arbor UI, a later stage). What this step delivers is the **server-side
truth** the client already reads:

- the project list, picker and creation reflect arbor's projects, because they
  read `ctx.workspaceRegistry`, which the bridge fills from the shared folder;
- the cwd display shows the shared folder, because the arbor session's cwd *is*
  the shared folder;
- the sandbox has no mode for an arbor session, so the switch has nothing to
  govern.

The one remaining client-side item is **hiding the sandbox mode switch and
filtering the project picker to arbor sessions**: both are per-session client
rendering that the compiled bundles do not yet key on the preset. The exact patch
points are `@deepseek-ai/dsh-client-ui-permission-presets` (the switch) and
`@deepseek-ai/dsh-client-ui-workspace` (`WorkspacePicker`); delivering them
cleanly is a `dsh.client` module in the later UI stage, and patching the compiled
bundle is not a change that survives reinstall.

## What arbor's core still lacks (back to the arbor repo)

1. **`Workspace.reclaimable?()`** — the interface assumes an implementation owns
   a directory it can remove. A workspace whose source is the user's shared
   folder would answer `false` and never reclaim. The arbor docs already describe
   it (`docs/workspaces.md#lifecycle`); it would let this deployment state that
   the shared folder is not its own to delete. Not needed yet: no retention is
   set, so nothing is reclaimed.
2. **`PromptSection.content(window)` with `perWindow: true`** — a host-level
   section is registered once per process and rendered per window, so a
   per-session section has to be declared per window. It would let the
   `<workspace>` section (and any arbor-session-only section) be exact per
   session rather than shared. The ovnfs section is per-host here (one shared
   folder), so it is already exact; the gap shows when a section must differ
   between an arbor and an ordinary session in one process.
3. **The judge is still off**, and with it the routing policy: one window per
   session, opened on the session's first turn.
4. **`models()` / `login()` are still placeholders**; the window's model comes
   from the DSH session's model selection.
