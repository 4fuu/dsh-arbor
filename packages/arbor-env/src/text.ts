/**
 * The model-facing text this environment contributes.
 *
 * Every fixed string this package writes lives here, in Chinese, one entry per
 * string. The host merges this table over its own, so the wording of a mounted
 * DSH skill's line and of a refusal is the deployment's.
 *
 * A mounted item's own description is DSH's, carried verbatim: a skill's
 * frontmatter description and an MCP server's are third-party content, and
 * restating them would put this package's words where DSH's belong.
 */

import type { TextTable } from '@4fu/arbor-interfaces'

/** This package's own fixed strings. */
export const dshEnvText: TextTable = {
  // ---- what a mounted item is -------------------------------------------
  'env.dsh.skill': 'DSH 的技能 {name}（只读）：{description}（{path}）。'
    + '技能自带的其他文件仍在 DSH 那边，按绝对路径用 read 或 bash 读取。',
  'env.dsh.server': 'DSH 的 MCP 服务器 {name}（只读）：它的工具作为 DSH 工具直接调用'
    + '（{tools}），不是本环境的模块函数，也不要为它再安装一个 MCP 服务器。',
  'env.dsh.server.notools': 'DSH 的 MCP 服务器 {name}（只读）：它当前没有发布任何工具。',
  // ---- refusals ---------------------------------------------------------
  'refused.env.dsh.readonly': '{kind} {name} 是 DSH 挂进来的，只读：不能用 reload 安装、移除或修改它。',
  'next.env.dsh.readonly': '要修改 DSH 这边的技能或 MCP 服务器，请在 DSH 中修改；'
    + '本环境只接受模型自己安装的技能、MCP 服务器和服务。',
}
