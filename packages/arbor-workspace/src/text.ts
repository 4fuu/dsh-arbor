/**
 * The prompt section and the model-facing text this workspace contributes
 * (docs/workspaces.md#prompt-text).
 *
 * Every fixed string this implementation writes lives here, in Chinese, one
 * entry per string: the prompt section that carries the method, the tool's
 * description and its results and refusals. The host merges this table over its
 * own when this implementation is the active workspace, so a host that ran
 * another implementation never shows this method.
 *
 * What the section says is only what is true here: the workspace is the DSH
 * session's own working directory, and every file access and every command of a
 * window runs through DSH's sandboxed filesystem and shell under the session's
 * own sandbox policy. There is no escalation line: decisions table revision 2
 * drops DSH's sandbox for arbor sessions, so the section states the policy that
 * stands and the refusal a write outside it meets, and names no tool for asking
 * for a wider one.
 *
 * Identifiers stay as they are: `workspace.path`, `read`, `write`, `edit`,
 * `bash`.
 */

import type { BlockKindSpec, PromptSection, TextTable } from '@4fu/arbor-interfaces'
import { textOf, zhTextTable, type TextArgs } from '@4fu/arbor-prompt'

/** This workspace's own fixed strings. */
export const dshWorkspaceText: TextTable = {
  // ---- the prompt section this implementation contributes -----------------
  'workspace.method.root': '你的工作区就是当前 DSH 会话的工作目录 {root}：read、write、edit 和 bash 都直接在这里工作，'
    + '没有属于某个窗口的子目录，也没有检出和合并。',
  'workspace.method.sandbox': '这些文件操作和命令都经过 DeepSeek Harness 的沙箱执行，和 DSH 自己的 bash、read、write、edit 走的是同一条路：'
    + '当前会话的沙箱模式是 {mode}，工作目录 {root} 是 workspace-write 的边界。',
  'workspace.method.readonly': '只读模式下任何写入都会被拒绝，拒绝信息里会说明原因和下一步；'
    + 'workspace-write 模式下只有 {root} 里的写入被允许；danger-full-access 不做限制。',
  'workspace.method.env': '/env 里的技能和 MCP 服务器是只读的：技能用 read 按路径读，MCP 的工具作为 DSH 工具直接调用。',
  'workspace.method.means': 'bash 在 {root} 里跑命令，后台作业用 bash_output 和 bash_stop 接着管。',
  // ---- results ----------------------------------------------------------
  'result.workspace.path': '{root}（会话工作目录，本会话的所有窗口都在这里工作：按约定不要改动别的会话的东西）',
  'function.workspace.path': '按窗口引用查询它所在的会话工作目录：本会话的所有窗口都在这一个目录里工作。',
  // ---- refusals ---------------------------------------------------------
  'refused.workspace.reclaim': '工作区就是会话自己的工作目录，不能被回收。',
  // ---- next actions -----------------------------------------------------
  'next.workspace.reclaim': '不需要处理：这个工作区不随窗口结束删除。',
  // ---- the file tools' refusals -----------------------------------------
  'refused.file.denied': '{marker}\n{detail}',
  'next.file.denied.readonly': '当前沙箱是只读，任何写入都会被拒绝：停下来向用户说明这一步需要写文件，'
    + '请用户自己决定要不要放宽沙箱模式，不要尝试绕过。',
  'next.file.denied.workspace': '当前沙箱是 workspace-write，只有 {root} 里的写入被允许：'
    + '把路径改到 {root} 内，或者停下来向用户说明这一步要写别处，请用户自己决定要不要放宽沙箱模式。',
}

/** The method's points, one text-table key per line, in order. */
const METHOD_LINES = [
  'workspace.method.root',
  'workspace.method.sandbox',
  'workspace.method.readonly',
  'workspace.method.env',
  'workspace.method.means',
]

/** The one block kind the section renders: its lines, no tag, not data. */
export const DSH_WORKSPACE_BLOCK: BlockKindSpec = {
  kind: 'dsh_workspace_method',
  data: false,
  fields: [
    { name: 'root', type: 'string', required: true },
    { name: 'mode', type: 'string', required: true },
  ],
  lines: [...METHOD_LINES],
}

/**
 * This implementation's prompt section.
 *
 * The root and the mode are read when the section is rendered, not when it is
 * registered: the host registers the section once per process, while the root
 * and the mode belong to the session whose turn is opening the window. A window
 * that opens therefore names its own session's directory and the mode that
 * stands for it, and a mid-session mode change reaches a live window as a
 * `prompt_delta` from the `<harness>` section the prompt bridge owns.
 */
export function dshWorkspaceSection(facts: () => { root: string; mode: string }): PromptSection {
  return {
    tag: 'workspace',
    blocks: [DSH_WORKSPACE_BLOCK],
    text: dshWorkspaceText,
    content: () => {
      const { root, mode } = facts()
      return [{ kind: 'dsh_workspace_method', fields: { root, mode } }]
    },
  }
}

/**
 * This implementation's strings over the framework's own, which is the table a
 * refusal is written from: a window reads arbor's wording for the parts the
 * core owns and this implementation's for the parts it owns.
 */
export const dshWorkspaceTable: TextTable = { ...zhTextTable, ...dshWorkspaceText }

/** One fixed string, from the table a window's refusals are written from. */
export function dshWorkspaceTextOf(key: string, args?: TextArgs): string {
  return textOf(dshWorkspaceTable, key, args, key)
}
