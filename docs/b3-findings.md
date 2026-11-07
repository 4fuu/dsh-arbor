# B3 findings: the arbor workspace over DSH's sandbox, and `/env`

Every finding below is backed by a proof in `proofs/` (run `pnpm proofs`), and
every DSH claim names the source location it rests on. DSH is tag
`dsh-v0.2.2-rc.1` (commit `66491b05e3`); arbor is `2026.1107.0`.

B3 replaces B1's workspace, whose file tools ran on the host — so DSH's file
policy did not apply to them at all — with one whose every file access and every
command goes through DSH's own seams. It also mounts `/env`.

## 1. Where DSH's own `bash`/`read`/`write`/`edit` get their answers

The shipped `headless` profile mounts all of this
(`packages/bundle/base/cordis.patch.yml`), and the proofs boot that profile:

| Seam | What the profile mounts | What it does |
| --- | --- | --- |
| `ctx.shell` | `@deepseek-ai/dsh-bash-sandbox`, row `bash-sandbox` | `SandboxBashExecutor` (`lib/types/index.d.ts`) wraps the exact argv through `ctx.sandbox` and stamps the run's facts on the result |
| `ctx.fs` | `@deepseek-ai/dsh-fs-sandbox`, row `fs-sandbox` | `SandboxedFileSystem` (`lib/types/index.d.ts`) extends `LocalFileSystem` and fences all five mutations by the per-call policy, throwing `FS_SANDBOX_DENIED` |
| `ctx.sandbox` | `@deepseek-ai/dsh-sandbox-local`, row `sandbox` | the confinement provider (`LocalSandboxProvider`); on this host landlock with `partial` enforcement |
| `ctx.sandboxPolicy` | `@deepseek-ai/dsh-sandbox-policy`, row `sandbox-policy` | `SandboxPolicyService.resolve({ session })` (`lib/types/index.d.ts`): the session's last `sandbox/mode` event, else the deployment default, with the session's immutable cwd as the `workspace-write` root |
| `ctx.approval` | `@deepseek-ai/dsh-user-approval`, row `approval` | the ask/decide service an escalation routes through |

Measured on the booted profile (`ctx.fs.sandboxMode` / `ctx.shell.sandboxMode`):
`workspace-write` by default, `read-only` when `DSH_PERMISSION_MODE=read-only`,
which is what the arbor overlay rewires and proof 11 runs under.

Two details that decide the implementation:

- **A direct call must resolve the policy itself.** `SandboxBashExecutor.resolve`
  reads `request.sandboxPolicy` and falls back to the *deployment* policy when it
  is absent (`@deepseek-ai/dsh-bash-sandbox`, `lib/index.js`, `resolve`). Both
  tool families resolve the session's policy per call before they execute
  (`@deepseek-ai/dsh-tool-fs/lib/index.js`, `FsSandboxController.resolvePolicy`;
  `@deepseek-ai/dsh-tool-bash/lib/index.js`, `resolveSandboxPolicy`). A workspace
  that did not would run every command under the deployment default and a
  mid-session mode switch would not reach it. Proof 11 asserts the mode a window
  runs under is the session's.
- **`SandboxedFileSystem` fences reads not at all** — every mode permits reading —
  and fences the five mutations. A write under `read-only` throws
  `FS_SANDBOX_DENIED` with `file access denied under read-only mode`, which
  `dsh-tool-fs` maps to the marker plus the escalation hint (`mapError`).

## 2. The workspace is the session's cwd, and owns the three capabilities

Arbor's own `bash`, `read`, `write` and `edit` are the core's
(`@4fu/arbor-tools`, `groups/files.js`) and reach a window's files only through
the `Workspace` interface (`@4fu/arbor-interfaces/workspace.d.ts`):

- `WorkspaceMount.exec` when the implementation owns the execution environment —
  and then `mount.path` is *not* a host path;
- `readFile` / `writeFile` when it can hand a file to the host;
- `mount.path` only when it has neither, in which case arbor's own
  `spawn('/bin/sh')` and `node:fs` run on the host.

`DshSandboxWorkspace` (`packages/arbor-workspace/src/workspace.ts`) provides all
three, so nothing a window does touches the host filesystem:

- `exec` runs one command through `ctx.shell.execute` under the session's policy;
- `readFile` runs through `ctx.fs.readText`;
- `writeFile` creates the parent directory through the same sandboxed shell, then
  `ctx.fs.writeText` under the session's policy;
- `mount.path` is the session's cwd, which *is* a host path — DSH's sandbox shares
  the host kernel and filesystem, so it is the honest answer and the one
  `workspace.path` gives.

There is no per-window directory and no checkout. B1 gave every window
`<cwd>/ws<N>`; DSH's sandbox is the boundary, so the isolation arbor's own
workspaces buy by copying files is not needed, and a directory per window inside
the user's project would only be litter. Consequences, all deliberate:

- `Workspace.reclaim` refuses. The workspace is the user's project; there is
  nothing to remove and removing it would delete work that is not arbor's.
- No `workspaces.retentionMs` is set, so the host never asks (proof 8 asserts
  both).
- `Workspace.quota` measures the session's cwd through `ctx.fs`; the host never
  calls it, because no deployment here sets a quota.

## 3. ovnfs is not offered inside DSH

Arbor's default workspace when the `ovnfs` binary is found is the ovnfs workspace
(`@4fu/arbor-workspace-ovnfs`, `ovnfs.js`): one shared folder read-only by
convention, a copy-on-write checkout per window, and `checkout`/`apply`/`status`
that run the ovnfs CLI as a host subprocess. It cannot sit on top of this one:

1. its `mount.readFile`/`writeFile` are `node:fs` calls on the host, so DSH's
   per-call fence never sees them;
2. its mount carries no `exec`, so a command would run on the host through
   arbor's own `spawn('/bin/sh')` — outside `ctx.shell` and outside the sandbox
   entirely;
3. its checkout operations spawn the ovnfs binary directly, which is a process
   DSH's sandbox does not wrap and cannot account for.

Its isolation is redundant here — DSH's sandbox already bounds file effects — and
its host-side subprocesses would be a hole straight through that sandbox. So the
ovnfs workspace is simply not mounted inside DSH; the note is at the top of
`packages/arbor-workspace/src/workspace.ts` so it cannot silently come back.

## 4. The escalation: one tool, and what its grant applies to

DSH's own `write`/`edit`/`bash` carry `sandbox_permissions` + `justification`, and
`approveEscalation` (`@deepseek-ai/dsh-sandbox/lib/types/escalation.d.ts`) runs
the ordered fail-closed sequence: repeating the effective mode needs no approval,
a strictly wider mode needs a non-empty justification and a grant, a narrower or
unsupported target is refused, and a missing approver, a missing agent or a
non-grant outcome fails closed.

Arbor's `write`, `edit` and `bash` carry no per-call permission argument — their
schemas are the core's — so the ask is a call of its own:
`sandbox_escalate(mode, justification)`, contributed through
`Workspace.groups` (`packages/arbor-workspace/src/group.ts`), which is the seam
the interface provides for "a capability the core does not name".

**Deviation, stated plainly:** in DSH an approved escalation applies to one call.
Here the grant is recorded for the session and applies to that session's file
access and commands from the next call on, because there is no per-call argument
to attach it to. Two things bound it: the grant is dropped as soon as the
session's standing mode moves (a UI switch or a `sandbox/mode` event), so a window
never runs wider than the user last agreed to; and it is in memory, so a restart
clears it. The `<workspace>` section says exactly this in Chinese.

## 5. `/env`: DSH's skills and MCP servers, read-only

`DshEnvironment` (`packages/arbor-env/src/index.ts`) wraps arbor's own
`DirectoryEnvironment`, whose home stays `<DSH_HOME>/arbor/env`: the settings at
`/env/settings.json`, arbor's built-in skills, and everything the model installs
itself with `reload` all keep working exactly as in any other deployment.

- **Skills** are read from `ctx.skills`, DSH's layered `SkillRegistry`
  (`@deepseek-ai/dsh-skill`, `lib/types/index.d.ts`), and mounted by writing each
  one's body to `<env>/skills/<name>/SKILL.md` — the layout arbor's environment
  already uses, so a mounted skill sits beside the model's own and reads the same
  way. The body and the description are DSH's, carried verbatim. The mount is
  re-read on `skills/change`, DSH's own invalidation event, so a skill a plugin
  adds or removes reaches `/env` without a restart. What is staged is the
  instruction file and nothing else; a skill's other files stay where DSH keeps
  them, and every sandbox mode permits reading them by absolute path.
- **MCP servers** are listed from the tools DSH publishes under
  `mcp__<serverName>__<rawName>` (`@deepseek-ai/dsh-mcp-client`, `lib/index.js`,
  `publicToolName`; the config's `serverName` must match `[A-Za-z0-9_-]{1,32}`, so
  the segment between the first `mcp__` and the next `__` is always the server's
  own name). DSH has no MCP registry service to ask, and the tool names are the
  same thing the tool bridge bridges. The item declares **no functions**, so no
  arbor MCP module is created for it: duplicating them as modules would give the
  model two ways to call the same tool.
- **The environment's directory is host data**, under `DSH_HOME/arbor` beside
  `journal.sqlite` and `notes.sqlite`, so it is written with `node:fs` like they
  are. It is not the session's workspace, and the sandbox that fences a window's
  files does not govern it.
- **A mounted item is read-only for `reload`**: installing or removing one is
  refused with the next action naming DSH as the place to change it.

The one thing B3 had to add to make this work: arbor reads its identity, general
rules, judge and model tiers from the environment once one is mounted, and
answers `undefined` until a settings item is installed — which would leave a
window with no identity at all. `DshEnvironment` therefore seeds its settings
from the host's own, so a fresh `DSH_HOME` behaves exactly as it did before
`/env` existed, and the model's own install replaces them the moment it makes one.

## 6. Two fixes the proofs forced

- **A refused call now reaches the model.** The core answers a refusal with an
  empty `content` and the rule, the message and the next action beside it
  (`@4fu/arbor-core`, `host.js`, `refusalText`), and the session log is the
  history the next model request is derived from. The driver was appending the
  empty content, so a window's refusal reached the model as an empty tool result.
  It now writes the same three parts `arbor-core` writes into the journal.
- **A window a restart continued is told the right root.** `Arbor.start`
  continues a stopped window and freezes that window's prefix there, with no turn
  in flight — so `ctx.agents.currentInitiator()` is `undefined` and the root fell
  back to the process's own directory. The host now notes every persisted
  session's cwd from DSH's own session persistence before `Arbor.start`, and the
  workspace falls back to the newest known root outside a turn.

## 7. What arbor's core still lacks (back to the arbor repo)

1. **`Workspace.reclaim` has no honest answer for a workspace that is somebody
   else's directory.** The interface assumes an implementation owns a directory
   it can remove. A deployment whose workspace is the user's project has to
   refuse, which is what this one does.
2. **A refusal's wording is not part of `ToolResult`.** `content` is empty and the
   three parts ride in `error`, so every embedding has to reassemble them for its
   own log. A `refusalText()` on the result, or a non-empty `content`, would
   remove the duplication.
3. **`Workspace.promptSection()` cannot name the window it is rendering for.** The
   host registers the section once per process and calls `content()` per render,
   so a host-level section has to guess which session is being rendered. A
   `content(window)` would make a per-session section exact rather than inferred.
4. **The judge is still off**, and with it the routing policy: one window per
   session, opened on the session's first turn.
5. **`models()` / `login()` are still placeholders**; the window's model comes
   from the DSH session's model selection.
