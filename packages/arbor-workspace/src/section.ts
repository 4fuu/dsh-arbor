/**
 * The external-project pointer lines, rendered inside arbor's own `<workspace>`.
 *
 * Arbor 2026.1107.1 makes this possible: `PromptSection.content(window)` is
 * called per render and `perWindow: true` tells the host the section answers
 * for the window it is rendered for, so the workspace implementation's own
 * section — the one `<workspace>` tag, built by arbor-core from the workspace
 * (`@4fu/arbor-core`, `host.js`, `addWorkspaceSection`) — can carry lines that
 * change while a window runs and reach it as a delta of only those lines.
 *
 * The owner's rule for this text is one home and the smallest set of facts:
 * "where you are" and "where the projects are" are both answered here, inside
 * `<workspace>`, and nowhere else. The workspace implementation's own lines
 * already say where the window works — the shared folder and the checkout
 * method — so this module adds only what they cannot say:
 *
 *  1. a lead line, only while at least one pointer exists;
 *  2. one line per external project: its name and its absolute path;
 *  3. why the two differ — the user added an existing directory, arbor did not
 *     copy it, so a change there lands on the user's own files;
 *  4. the one consequence the model has to act on: edit an external project in
 *     place, because there is nothing to merge.
 *
 * No tool documentation is restated and no general advice is added. The paths
 * are absolute and arbor's own file tools take an absolute path wherever it
 * names (`@4fu/arbor-tools`, `groups/files.js`, `hostPath`: "itself when it is
 * absolute, under the workspace when it is not"), and the shell tool runs on the host,
 * so the line promises only what a tool does.
 *
 * The lines are rendered as blocks of this module's own kinds, the way arbor
 * renders every list: the renderer writes the words, the block carries the
 * data, and a line whose placeholders have no value is dropped rather than
 * rendered half-empty.
 */

import type { Block, BlockKindSpec, PromptSection, TextTable, WindowRef } from '@4fu/arbor-interfaces'
import type { ExternalPointer, ExternalProject } from './projects.ts'

/** Where the pointers come from, read at every render of the section. */
export interface PointerSource {
  /**
   * Every recorded pointer of the session the named window serves whose
   * directory still exists, true at the moment it is read: a pointer whose
   * directory is gone is not listed, so the prompt never names a path that no
   * longer exists. The window is what the section is rendered for, so the
   * answer is that window's session's list and never another session's.
   */
  list(window?: WindowRef): Promise<readonly ExternalPointer[]>
  /**
   * The project of the shared folder the named window's session works in, or
   * undefined when the session named none — the shared folder itself, or a
   * directory that is not a project. This is the line that answers "where is my
   * project" for a session the user opened on one, and it is absent rather than
   * empty when there is nothing to name.
   */
  project?(window?: WindowRef): ExternalProject | undefined | Promise<ExternalProject | undefined>
  /**
   * A revision that moves whenever that set moves, so the host re-renders the
   * section and hands a live window a delta of only the changed lines. It is
   * asked once per step, so it is where the existence check happens: a
   * directory that disappears between two renders moves this on the next read.
   */
  revision(): string | number | Promise<string | number>
}

/**
 * The fixed strings this module writes, in Chinese like every other
 * model-facing line arbor and dsh-arbor write. Identifiers stay as they are.
 */
export const POINTER_TEXT: TextTable = {
  // Worded for either workspace implementation: the ovnfs workspace has a shared
  // folder the pointer is outside of, and the plain-directory workspace has no
  // shared folder at all, so the line states only what is true of both — the
  // directory is the user's own, at its original path, and arbor works in it
  // directly rather than through a copy or a mount.
  'workspace.external.lead': '用户另外添加的目录（未复制、未挂载，arbor 按原路径直接使用）：',
  'workspace.external.item': '外部项目 {name}：{path}',
  'workspace.external.reason': '用户添加的是已有目录，arbor 没有复制它：这些路径上的修改直接落在用户自己的文件上。',
  'workspace.external.consequence': '要修改外部项目就在原处修改：按上面的绝对路径直接读写执行，没有检出、没有 apply，也没有可合并的东西。',
  // The project the session was opened on, and how the window reaches it. The
  // name is the project folder's own and the path is its place in the shared
  // folder, so this line, the DSH project list and the checkout all agree. The
  // reach line is the implementation's own, because the two get there
  // differently: ovnfs opens a checkout of the project subfolder, and the plain
  // directory workspace works in a directory of its own and reaches the project
  // by its absolute path.
  'workspace.project.item': '当前项目 {name}：{path}',
  // Arbor's own ovnfs lines already say where the shared folder is, that every
  // window reads from it, that the shell tool runs there by default and that a change
  // goes through a checkout (`workspace.method.shared`, `workspace.method.open`,
  // `workspace.method.readonly`), so this line adds only what they cannot say
  // about one project: that it is a subdirectory of that same place, so the
  // path the line names and the relative path `{name}/` both reach it with no
  // `cd` and no exploration — and that reading it in place is fine, because
  // only a change needs a checkout.
  'workspace.project.ovnfs': '它在共享目录里，子目录是 {name}：读取它就读 {path}，或按 {name}/ 读取，不用创建检出、不用 cd；要修改它就用 workspace.checkout 为它创建检出（子目录填 {name}），修改完成后用 workspace.apply 合回共享目录。',
  'workspace.project.directory': '它在共享目录里，路径就是 {path}；本窗口另有自己的工作目录，按这个绝对路径直接读写该项目。',
}

/** The lead line: untagged, no fields, written once before the items. */
const POINTER_LEAD_BLOCK: BlockKindSpec = {
  kind: 'workspace_external_lead',
  data: false,
  fields: [],
  lines: ['workspace.external.lead'],
}

/** One external project per block: its name and its absolute path. */
const POINTER_ITEM_BLOCK: BlockKindSpec = {
  kind: 'workspace_external',
  data: false,
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'path', type: 'string', required: true },
  ],
  lines: ['workspace.external.item'],
}

/** The reason and the consequence, written once after the items. */
const POINTER_NOTE_BLOCK: BlockKindSpec = {
  kind: 'workspace_external_note',
  data: false,
  fields: [],
  lines: ['workspace.external.reason', 'workspace.external.consequence'],
}

/**
 * The project the session works in: its name, its path, and how the window
 * reaches it. The reach line is one of two, chosen by the workspace
 * implementation this deployment runs, and the block carries the name and the
 * path so the checkout a window opens names the project the prompt named.
 *
 * The `reach` field names which reach line to write, and the renderer resolves
 * a line key that names a field (`workspace.project.{reach}`), so the words stay
 * in the text table and only the choice travels in the block.
 */
const PROJECT_BLOCK: BlockKindSpec = {
  kind: 'workspace_project',
  data: false,
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'path', type: 'string', required: true },
    { name: 'reach', type: 'string', required: true },
  ],
  lines: ['workspace.project.item', 'workspace.project.{reach}'],
}

/**
 * Which reach line each workspace implementation's project gets.
 *
 * Arbor's own prompt keys name the plain-directory implementation `directory`
 * (`workspace.method.directory`), while `openWorkspace` reports the backend it
 * settled on as `dir` (`@4fu/arbor-core`, `WorkspaceBackend`), so the id is
 * mapped to the key here rather than the key being renamed to the id.
 */
export const REACH_OF: Record<'ovnfs' | 'dir', 'ovnfs' | 'directory'> = {
  ovnfs: 'ovnfs',
  dir: 'directory',
}

/** The blocks this module adds to the section's own. */
export const POINTER_BLOCKS: readonly BlockKindSpec[] = [
  PROJECT_BLOCK,
  POINTER_LEAD_BLOCK,
  POINTER_ITEM_BLOCK,
  POINTER_NOTE_BLOCK,
]

/**
 * Extend the workspace implementation's own `<workspace>` section with the
 * session's project and the external-project pointers.
 *
 * The base section is the ovnfs one (or the plain-directory one): its tag, its
 * block kinds, its text table and its `content`. Everything it says is kept
 * exactly as it stands and the added lines follow it, so the method a window
 * follows, the project the session was opened on and the directories a user
 * added are answered in one place, in one tag. `perWindow: true` is what the API
 * asks of a section that answers for the window it is rendered for, which is what
 * the workspace's own section is.
 *
 * @param base - the implementation's own section, from `workspace.promptSection`.
 * @param pointers - where the pointers and the project are read from, per render.
 * @param reach - which reach line the project's block carries, so the line is
 *   the one that is true: `ovnfs` opens a checkout of the project subfolder,
 *   `directory` reaches it by absolute path.
 */
export function withPointerSection(
  base: PromptSection,
  pointers: PointerSource,
  reach: 'ovnfs' | 'directory',
): PromptSection {
  return {
    tag: base.tag,
    blocks: [...base.blocks, ...POINTER_BLOCKS],
    text: { ...(base.text ?? {}), ...POINTER_TEXT },
    content: async (window) => {
      // The implementation's own lines first: where the window works. A section
      // whose content failed keeps what it last said, so this is awaited inside
      // the same try the host renders under.
      const method: readonly Block[] = await base.content(window)
      const project = await pointers.project?.(window)
      const listed = await pointers.list(window)
      const blocks: Block[] = [...method]
      // The project the session was opened on, named once. A session that named
      // none has no line at all: the implementation's own lines already say
      // where the window works, and an empty "current project" would be noise.
      if (project !== undefined) {
        blocks.push({
          kind: 'workspace_project',
          fields: { name: project.name, path: project.path, reach },
        })
      }
      // Nothing recorded, or nothing that still exists: no line at all, rather
      // than a lead line about nothing.
      if (listed.length > 0) {
        blocks.push({ kind: 'workspace_external_lead', fields: {} })
        for (const pointer of listed) {
          blocks.push({
            kind: 'workspace_external',
            fields: { name: pointer.name, path: pointer.path },
          })
        }
        blocks.push({ kind: 'workspace_external_note', fields: {} })
      }
      return blocks
    },
    revision: () => pointers.revision(),
    perWindow: true,
  }
}
