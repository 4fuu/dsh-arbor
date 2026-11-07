/**
 * @4fu/dsh-arbor-workspace — the arbor `Workspace` over DSH's sandbox.
 *
 * The session's cwd is the shared root; every file access and every command of
 * a window runs through DSH's own `ctx.fs` and `ctx.shell` under the session's
 * resolved sandbox policy, so DSH's sandbox mode and its approval path apply to
 * arbor's `bash`, `read`, `write` and `edit` exactly as they do to DSH's own
 * tools of the same names.
 *
 * Arbor's default workspace when the `ovnfs` binary is found is deliberately
 * not offered inside DSH; see the note at the top of `./workspace.ts`.
 */

export { DshSandboxWorkspace, type DshWorkspaceOptions } from './workspace.ts'
export {
  DshSandboxSeam,
  deny,
  denialMarker,
  type CommandOutcome,
  type EscalationAsk,
  type SandboxFacts,
  type SandboxedShellRequest,
} from './seam.ts'
export { DshWorkspaceGroup, ESCALATE_TOOL } from './group.ts'
export { dshWorkspaceSection, dshWorkspaceText, DSH_WORKSPACE_BLOCK } from './text.ts'
