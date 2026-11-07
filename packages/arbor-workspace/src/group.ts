/**
 * What this workspace adds to the catalog: the escalation tool and the
 * `workspace.path` module function (docs/tools.md#external-tools,
 * docs/workspaces.md).
 *
 * `sandbox_escalate` is the one capability the core does not name and this
 * deployment has: a window asks the user for a wider sandbox mode, through
 * DSH's approval, before anything runs. Arbor's own `write`, `edit` and `bash`
 * carry no per-call permission argument — their schemas are the core's — so the
 * ask is a call of its own, and the grant it answers with is what this
 * workspace's file access and commands then run under. The choreography is
 * DSH's own: `approveEscalation` with `ctx.get('approval')` on the calling
 * session's agent, exactly the sequence `dsh-tool-fs` runs for a
 * `sandbox_permissions` argument.
 *
 * `workspace.path` answers another window's directory by its window. Here every
 * window of a session works in that session's cwd, so the answer names the
 * shared root — which is what makes the convention readable rather than a rule
 * this implementation enforces.
 */

import type { DirectToolSpec, TextTable, ToolCall, ToolGroup, ToolResult, WindowRef } from '@4fu/arbor-interfaces'
import { textOf } from '@4fu/arbor-prompt'
import type { DshSandboxWorkspace } from './workspace.ts'

/** The tool name a window asks a wider sandbox mode through. */
export const ESCALATE_TOOL = 'sandbox_escalate'

export class DshWorkspaceGroup implements ToolGroup {
  readonly id = 'workspace.dsh'

  private readonly workspace: DshSandboxWorkspace
  private readonly table: TextTable

  constructor(workspace: DshSandboxWorkspace, table: TextTable) {
    this.workspace = workspace
    this.table = table
  }

  tools(): readonly DirectToolSpec[] {
    return [{
      name: ESCALATE_TOOL,
      description: textOf(this.table, 'function.sandbox_escalate'),
      parameters: {
        mode: {
          type: 'string',
          required: true,
          description: '要申请的模式：workspace-write 或 danger-full-access。',
        },
        justification: {
          type: 'string',
          required: true,
          description: '用一句话向用户说明为什么当前这一步需要更宽的权限，会和审批提示一起展示。',
        },
      },
    }]
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

  async call(request: ToolCall, context: { window: WindowRef }): Promise<ToolResult> {
    switch (request.name) {
      case ESCALATE_TOOL:
        return this.escalate(request, context.window)
      case 'workspace.path':
        return this.path(request)
      default:
        return this.notOwned(request)
    }
  }

  /**
   * Ask the user for a wider sandbox mode, through DSH's approval.
   *
   * The grant is recorded for the session that asked, and every file access and
   * command of that session's windows runs under it from the next call on.
   */
  private async escalate(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const mode = stringArg(request.args, 'mode')
    const justification = stringArg(request.args, 'justification')
    try {
      const granted = await this.workspace.escalate(window, request.callId, mode, justification)
      return {
        callId: request.callId,
        ok: true,
        content: textOf(this.table, 'result.sandbox_escalate', { mode: granted }),
      }
    } catch (error: unknown) {
      return this.refusalOf(request, error)
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

  /**
   * One refusal this group answered with, in the core's error shape. The rule
   * names the table entry that carries its wording, exactly the way a note
   * store's refusal reaches the model.
   */
  private refusalOf(request: ToolCall, error: unknown): ToolResult {
    const info = error as { rule?: string; message?: string; nextAction?: string }
    return {
      callId: request.callId,
      ok: false,
      content: '',
      error: {
        rule: info.rule ?? 'sandbox_escalate.failed',
        message: info.message ?? (error instanceof Error ? error.message : String(error)),
        ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
      },
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

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value : ''
}

function windowArg(value: unknown): WindowRef {
  return typeof value === 'string' ? value as WindowRef : 'c0' as WindowRef
}
