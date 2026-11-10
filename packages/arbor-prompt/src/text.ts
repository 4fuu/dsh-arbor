/**
 * dsh-arbor's own text table: every fixed string the DSH bridge writes into a
 * window's system prompt, in Chinese like arbor's own table
 * (`@4fu/arbor-prompt` `zhTextTable`).
 *
 * A deployment replaces the table to change the wording; no fixed text is
 * written anywhere else. Identifiers — tool names, section tags, enum values —
 * stay as they are.
 *
 * DSH's own tool usage text is deliberately NOT here: it is carried through
 * verbatim as data inside the `<harness>` section, in its original English,
 * because it is DSH's wording rather than this bridge's.
 */

import type { TextTable } from '@4fu/arbor-interfaces'

/** Every key this table owns, so a replacement can be checked against it. */
export const DSH_TEXT_KEYS: readonly string[] = [
  'dsh.harness.lead',
  'dsh.harness.approval.ask',
  'dsh.harness.approval.never',
  'dsh.harness.send.image',
  'dsh.harness.send.file',
  'dsh.harness.send.present',
  'dsh.harness.send.target',
  'dsh.harness.reference',
  'dsh.harness.plan.lead',
  'dsh.harness.tool',
]

/** The fixed strings the `<harness>` section writes. */
export const dshTextTable: TextTable = {
  // The lead line: what this window is. The identity says who the agent works
  // for; arbor's own `<agent>` rules say that only `send` reaches the user and
  // that a finished round leaves the window idle, so neither is repeated here.
  'dsh.harness.lead':
    '这个窗口运行在 DeepSeek Harness（DSH）中：DSH 是外层环境，arbor 是它的 agent 驱动。',

  // Approval policy: DSH's two policies, in this bridge's words. The routing
  // itself is DSH's — a call that needs approval goes through the session's
  // approval path, and an absent answerer fails closed. Nothing here names an
  // escalation: an arbor session has none, so the `never` line states only what
  // the policy does.
  'dsh.harness.approval.ask':
    '本会话会弹出审批：需要审批的操作会请用户批准；没有人能批准时按拒绝处理。',
  'dsh.harness.approval.never':
    '本会话不弹出审批：需要审批的操作一律自动拒绝。',

  // How to write links into `send`, so DSH renders them. DSH's own
  // `ui:deliverable-file-references` section speaks of the final response; in
  // arbor only `send` reaches the user, so the wording is `send`'s.
  'dsh.harness.send.image': '在 send 中插入图片用 ![说明](<绝对路径>)，DSH 会直接渲染这张图。',
  'dsh.harness.send.file':
    '在 send 中链接文件用 [文件名](<路径#L24>)；路径用尖括号包住，尤其是含空格的路径。'
    + '已知行号时在路径后追加 #L24 或 #L24-L30。',
  'dsh.harness.send.present':
    '交付完整文件（图片、Office 文档、表格、幻灯片）时用 present，用户可以直接预览和打开。',
  // The one outside channel this deployment has. Arbor's `send` takes a target
  // and the queue carries the effect out only when an executor owns that
  // target, so the target has to be named: `dsh:user` is what
  // `@4fu/dsh-arbor-host`'s `DshSendExecutor` owns, and it resolves to the user
  // of the session that sent. No braces in the line: the renderer drops a
  // fixed line whose filled text still holds one.
  'dsh.harness.send.target':
    '要发送给用户的内容用 send 发送，to 写 dsh:user。'
    + '本部署只有这一个对外通道，内容会作为本会话的一条助手消息写入 DSH 的会话记录。',

  // `@path` references: DSH's `context:file-reference`, rewritten for arbor.
  // The root is arbor's own workspace root rather than the DSH session's cwd,
  // because arbor takes over project management for an arbor session: the
  // project is arbor's shared folder and a window works in its own checkout of
  // it, and arbor's <workspace> section names that root.
  'dsh.harness.reference':
    '用户消息中以 @ 开头的是用户引用的路径：相对路径从 arbor 的工作区根目录算起，以 / 结尾的是目录，其余用 read 读取。',

  // Plan mode: the deployment's own guidance, kept verbatim, with a lead line
  // of this bridge's. Written only while plan mode is active.
  'dsh.harness.plan.lead': '用户开启了计划模式，以下是本部署配置的计划模式要求：',

  // One DSH tool's usage text, carried through verbatim.
  'dsh.harness.tool': '{name}：{text}',
}
