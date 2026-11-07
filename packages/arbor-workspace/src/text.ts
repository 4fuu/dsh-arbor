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
 * session's own working directory, every file access and every command of a
 * window runs through DSH's sandboxed filesystem and shell under the session's
 * own sandbox policy, and the one way to a wider mode is the escalation tool,
 * which asks the user through DSH's approval.
 *
 * Identifiers stay as they are: `sandbox_escalate`, `workspace.path`, `read`,
 * `write`, `edit`, `bash`.
 */

import type { BlockKindSpec, PromptSection, TextTable } from '@4fu/arbor-interfaces'

/** This workspace's own fixed strings. */
export const dshWorkspaceText: TextTable = {
  // ---- the prompt section this implementation contributes -----------------
  'workspace.method.root': '你的工作区就是当前 DSH 会话的工作目录 {root}：read、write、edit 和 bash 都直接在这里工作，'
    + '没有属于某个窗口的子目录，也没有检出和合并。',
  'workspace.method.sandbox': '这些文件操作和命令都经过 DeepSeek Harness 的沙箱执行，和 DSH 自己的 bash、read、write、edit 走的是同一条路：'
    + '当前会话的沙箱模式是 {mode}，工作目录 {root} 是 workspace-write 的边界。',
  'workspace.method.readonly': '只读模式下任何写入都会被拒绝，拒绝信息里会说明原因和下一步；'
    + 'workspace-write 模式下只有 {root} 里的写入被允许；danger-full-access 不做限制。',
  'workspace.method.escalate': '需要更宽的权限时调用 sandbox_escalate(mode, justification)：'
    + '它会经 DSH 的审批请用户批准，用一句话说明为什么这一步需要更宽的权限；'
    + '批准后这个会话的文件操作和命令按批准的模式执行，直到用户在 DSH 里切换沙箱模式。',
  'workspace.method.env': '/env 里的技能和 MCP 服务器是只读的：技能用 read 按路径读，MCP 的工具作为 DSH 工具直接调用。',
  'workspace.method.means': 'bash 在 {root} 里跑命令，后台作业用 bash_output 和 bash_stop 接着管。',
  // ---- the tool this implementation adds ---------------------------------
  'function.sandbox_escalate': '请用户批准更宽的沙箱模式：mode 取 workspace-write 或 danger-full-access，'
    + 'justification 是用一句话说明为什么当前这一步需要它。批准后这个会话的文件操作和命令按批准的模式执行。',
  // ---- results ----------------------------------------------------------
  'result.sandbox_escalate': '已批准把沙箱模式提到 {mode}。这个会话后续的文件操作和命令按这个模式执行，'
    + '直到用户在 DSH 里切换沙箱模式。',
  'result.workspace.path': '{root}（会话工作目录，本会话的所有窗口都在这里工作：按约定不要改动别的会话的东西）',
  'function.workspace.path': '按窗口引用查询它所在的会话工作目录：本会话的所有窗口都在这一个目录里工作。',
  // ---- refusals ---------------------------------------------------------
  'refused.sandbox_escalate.mode': 'mode 只能是 workspace-write 或 danger-full-access，收到的是 {mode}。',
  'refused.sandbox_escalate.justification': 'justification 不能为空：用一句话向用户说明为什么这一步需要更宽的权限。',
  'refused.sandbox_escalate.narrower': '{mode} 不比当前的 {current} 更宽，不需要审批。',
  'refused.sandbox_escalate.rejected': '用户拒绝了把沙箱模式提到 {mode} 的请求：这一步仍然被拒绝，停下来向用户说明，不要绕过它。',
  'refused.sandbox_escalate.cancelled': '提请批准 {mode} 的审批被取消了：这一步没有执行，向用户说明后再决定怎么做。',
  'refused.sandbox_escalate.unavailable': '没有可用的审批通道，无法请用户批准更宽的模式：停下来向用户说明，不要绕过它。',
  'refused.sandbox_escalate.absent': '这个组合没有挂载任何沙箱后端，没有可用的沙箱模式可提。',
  'refused.sandbox_escalate.failed': '提请批准 {mode} 失败了：{mode} 没有生效，向用户说明后再决定怎么做。',
  'refused.workspace.reclaim': '工作区就是会话自己的工作目录，不能被回收。',
  // ---- next actions -----------------------------------------------------
  'next.sandbox_escalate.mode': 'mode 取 workspace-write 或 danger-full-access。',
  'next.sandbox_escalate.justification': '补一句理由，例如「要把构建产物写到仓库外的缓存目录」。',
  'next.sandbox_escalate.narrower': '直接用当前模式重试这一步。',
  'next.sandbox_escalate.rejected': '向用户说明这一步被拒绝的原因，并给出不需要更宽权限的做法。',
  'next.sandbox_escalate.cancelled': '问用户是否还要申请更宽的权限，或者给出不需要更宽权限的做法。',
  'next.sandbox_escalate.unavailable': '请用户在 DSH 里接一个审批通道，或者给出不需要更宽权限的做法。',
  'next.sandbox_escalate.absent': '直接重试这一步；这个组合不限制文件写入。',
  'next.sandbox_escalate.failed': '稍后重试，或者向用户说明当前无法取得更宽的权限。',
  'next.workspace.reclaim': '不需要处理：这个工作区不随窗口结束删除。',
  // ---- the file tools' refusals -----------------------------------------
  'refused.file.denied': '{marker}\n{detail}',
  'next.file.denied.readonly': '当前沙箱是只读，任何写入都会被拒绝。要让用户批准更宽的模式：调用 '
    + 'sandbox_escalate(mode, justification)，用一句话说明这一步为什么需要更宽的权限；'
    + '批准后本窗口后续的文件操作和命令按批准的模式执行。',
  'next.file.denied.workspace': '当前沙箱是 workspace-write，只有 {root} 里的写入被允许。'
    + '要写别处：调用 sandbox_escalate(mode, justification) 请用户批准更宽的模式，或把路径改到 {root} 内。',
}

/** The method's points, one text-table key per line, in order. */
const METHOD_LINES = [
  'workspace.method.root',
  'workspace.method.sandbox',
  'workspace.method.readonly',
  'workspace.method.escalate',
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
