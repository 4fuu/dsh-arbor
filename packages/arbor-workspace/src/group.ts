/**
 * What this workspace adds to the catalog: the `workspace.path` module function
 * (docs/tools.md#external-tools, docs/workspaces.md).
 *
 * It used to add an escalation tool as well. Decisions table revision 2 drops
 * DSH's sandbox for arbor sessions, so the ask it carried — a wider DSH sandbox
 * mode, granted through DSH's approval — names a capability that no longer
 * exists here. The tool is gone rather than hidden: a tool the model cannot
 * call must not be written into the prompt either. B3b replaces this whole
 * group when it moves the workspace onto arbor's own.
 *
 * `workspace.path` answers another window's directory by its window. Here every
 * window of a session works in that session's cwd, so the answer names the
 * shared root — which is what makes the convention readable rather than a rule
 * this implementation enforces.
 */

import type { TextTable, ToolCall, ToolGroup, ToolResult, WindowRef } from '@4fu/arbor-interfaces'
import { textOf } from '@4fu/arbor-prompt'
import type { DshSandboxWorkspace } from './workspace.ts'

export class DshWorkspaceGroup implements ToolGroup {
  readonly id = 'workspace.dsh'

  private readonly workspace: DshSandboxWorkspace
  private readonly table: TextTable

  constructor(workspace: DshSandboxWorkspace, table: TextTable) {
    this.workspace = workspace
    this.table = table
  }

  /**
   * No direct tools.
   *
   * The escalation tool this group used to add is gone: decisions table
   * revision 2 drops DSH's sandbox for arbor sessions, so a tool that asks the
   * user for a wider DSH sandbox mode would name a capability that does not
   * exist. The module function below stays, and B3b replaces this whole group
   * when it moves the workspace onto arbor's own.
   */
  tools(): readonly never[] {
    return []
  }

  modules() {
    return [{
      name: 'workspace',
      description: textOf(this.table, 'module.workspace'),
      functions: [{
        name: 'workspace.path',
        signature: 'workspace.path(window)',
        description: textOf(this.table, 'function.workspace.path'),
      }],
    }]
  }

  async call(request: ToolCall, _context: { window: WindowRef }): Promise<ToolResult> {
    switch (request.name) {
      case 'workspace.path':
        return this.path(request)
      default:
        return this.notOwned(request)
    }
  }

  /** Another window's directory, by its window. */
  private async path(request: ToolCall): Promise<ToolResult> {
    const window = windowArg(request.args.window)
    const root = await this.workspace.rootOf(window)
    if (root === undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: '',
        error: {
          rule: 'workspace.not_found',
          message: textOf(this.table, 'refused.workspace.path', { window }),
          nextAction: textOf(this.table, 'next.workspace.path'),
        },
      }
    }
    return {
      callId: request.callId,
      ok: true,
      content: textOf(this.table, 'result.workspace.path', { window, root }),
    }
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: '',
      error: {
        rule: 'tool.not_owned',
        message: textOf(this.table, 'refused.unknown_tool', { name: request.name }),
        nextAction: textOf(this.table, 'next.unknown_tool'),
      },
    }
  }
}

function windowArg(value: unknown): WindowRef {
  return typeof value === 'string' ? value as WindowRef : 'c0' as WindowRef
}
