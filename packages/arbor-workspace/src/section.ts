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
 * absolute, under the workspace when it is not"), and `bash` runs on the host,
 * so the line promises only what a tool does.
 *
 * The lines are rendered as blocks of this module's own kinds, the way arbor
 * renders every list: the renderer writes the words, the block carries the
 * data, and a line whose placeholders have no value is dropped rather than
 * rendered half-empty.
 */

import type { Block, BlockKindSpec, PromptSection, TextTable, WindowRef } from '@4fu/arbor-interfaces'
import type { ExternalPointer } from './projects.ts'

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
  'workspace.external.reason': '用户添加的是已有目录，arbor 没有复制它：这些路径上的改动直接落在用户自己的文件上。',
  'workspace.external.consequence': '要改外部项目就在原处改：按上面的绝对路径直接读写执行，没有检出、没有 apply，也没有可合并的东西。',
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

/** The blocks this module adds to the section's own. */
export const POINTER_BLOCKS: readonly BlockKindSpec[] = [
  POINTER_LEAD_BLOCK,
  POINTER_ITEM_BLOCK,
  POINTER_NOTE_BLOCK,
]

/**
 * Extend the workspace implementation's own `<workspace>` section with the
 * external-project pointers.
 *
 * The base section is the ovnfs one (or the plain-directory one): its tag, its
 * block kinds, its text table and its `content`. Everything it says is kept
 * exactly as it stands and the pointer lines are appended after it, so the
 * method a window follows and the directories a user added are answered in one
 * place, in one tag. `perWindow: true` is what the API asks of a section that
 * answers for the window it is rendered for, which is what the workspace's own
 * section is.
 *
 * @param base - the implementation's own section, from `workspace.promptSection`.
 * @param pointers - where the pointers are read from, per render.
 */
export function withPointerSection(base: PromptSection, pointers: PointerSource): PromptSection {
  return {
    tag: base.tag,
    blocks: [...base.blocks, ...POINTER_BLOCKS],
    text: { ...(base.text ?? {}), ...POINTER_TEXT },
    content: async (window) => {
      // The implementation's own lines first: where the window works. A section
      // whose content failed keeps what it last said, so this is awaited inside
      // the same try the host renders under.
      const method: readonly Block[] = await base.content(window)
      const listed = await pointers.list(window)
      // Nothing recorded, or nothing that still exists: no line at all, rather
      // than a lead line about nothing.
      if (listed.length === 0) return method
      return [
        ...method,
        { kind: 'workspace_external_lead', fields: {} },
        ...listed.map(pointer => ({
          kind: 'workspace_external',
          fields: { name: pointer.name, path: pointer.path },
        })),
        { kind: 'workspace_external_note', fields: {} },
      ]
    },
    revision: () => pointers.revision(),
    perWindow: true,
  }
}
