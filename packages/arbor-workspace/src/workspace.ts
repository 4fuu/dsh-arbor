/**
 * Arbor's own `Workspace`, rooted at the arbor shared folder (docs/workspaces.md).
 *
 * B3 ran a window's files through DSH's sandbox (`ctx.fs` / `ctx.shell`) and
 * refused to mount ovnfs, because ovnfs's host-side `node:fs`, `spawn('/bin/sh')`
 * and daemon subprocess would be a hole straight through that sandbox. The
 * owner's decision for arbor sessions reverses that: arbor's tools run on the
 * host the way they do in standalone arbor, and the only protection is arbor's
 * own secret scrub on what reaches the model. With the sandbox gone, ovnfs is
 * exactly the right workspace again, and this module mounts it.
 *
 * So a window's workspace is arbor's own, chosen by arbor-core's `openWorkspace`:
 *
 *  - **ovnfs** (the default) when its binary is found and its daemon starts: one
 *    shared folder — `DSH_HOME/arbor/shared` — that holds several projects and
 *    git repositories, with a copy-on-write checkout per window that a window
 *    opens (`workspace.checkout`), works in and merges back (`workspace.apply`).
 *  - the **plain directory** workspace when ovnfs is unavailable: one directory
 *    per window under `DSH_HOME/arbor/workspaces`, plus persistent directories.
 *
 * Nothing here reaches DSH's filesystem or shell seams, and there is no
 * `DshSandboxSeam`, no `sandbox_escalate` and no `fileToolsSandboxed` any more.
 * The shared folder, the ovnfs state and the checkouts all live under
 * `DSH_HOME/arbor/`, beside the journal and the note store, so a DSH restart
 * keeps every project and every window. The `<workspace>` prompt section and the
 * `workspace.*` module functions are ovnfs's (or the directory workspace's) own
 * — arbor's wording, arbor's method, no sandbox line.
 *
 * The companion `./projects.ts` makes the shared folder's project subfolders the
 * DSH project list (`ctx.workspaceRegistry`), which is the other half of arbor
 * taking over DSH's project management, and `./section.ts` extends that same
 * `<workspace>` section with the external-project pointers (see
 * {@link withArborWorkspace}).
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openWorkspace, type OpenWorkspaceResult, type WorkspaceBackend } from '@4fu/arbor-core'
import type { Journal, TextTable, Workspace } from '@4fu/arbor-interfaces'
import { withPointerSection, type PointerSource } from './section.ts'

/** Inputs for {@link openArborWorkspace}. */
export interface ArborWorkspaceOptions {
  /** The arbor data root, `DSH_HOME/arbor`: the shared folder lives under it. */
  readonly root: string
  /** The journal, for the checkout events ovnfs records and chain resolution. */
  readonly journal: Journal
  /**
   * The shared folder. Defaults to `<root>/shared`. It holds one subfolder per
   * project; ovnfs reads it as its source and the project bridge lists it.
   */
  readonly source?: string
  /** The ovnfs binary to run; `ovnfs` on PATH by default. Tests pin a stand-in. */
  readonly bin?: string
  /** Called with a non-fatal note, such as a version mismatch or the fallback. */
  readonly warn?: (message: string) => void
  /**
   * Where the external-project pointers are read from. Absent leaves the
   * workspace implementation's own section untouched — a host with no project
   * bridge, such as a test that only wants a workspace.
   */
  readonly pointers?: PointerSource
}

/** The workspace arbor runs with, and the shared folder it is rooted at. */
export interface ArborWorkspace extends OpenWorkspaceResult {
  /** The shared folder every window works in: ovnfs's source, the projects' home. */
  readonly sharedFolder: string
  /** Which backend `openWorkspace` settled on, so the host can report it. */
  readonly backend: WorkspaceBackend
  /** The workspace itself: ovnfs, or the plain-directory fallback. */
  readonly workspace: Workspace
}

/**
 * The shared folder under one arbor data root.
 *
 * It is the source of truth for arbor sessions: a DSH project is a subfolder of
 * it, and it is where ovnfs merges a checkout back so the change shows in the
 * project the DSH UI lists.
 */
export function arborSharedFolder(root: string, source?: string): string {
  return source ?? join(root, 'shared')
}

/**
 * Wrap arbor's own workspace so its `<workspace>` prompt section also names the
 * external-project pointers, and so it states that nothing here is reclaimed.
 *
 * Two overrides, everything else forwarded. A `Proxy` rather than a hand-written
 * delegation, because `Workspace` gains members as arbor grows — a checkout
 * query, a keep, an environment hook — and a wrapper that listed today's members
 * would silently drop tomorrow's capability instead of forwarding it.
 *
 *  - **`promptSection`** hands the implementation's own section (ovnfs's, or the
 *    plain-directory workspace's) to {@link withPointerSection}, which keeps
 *    every one of its lines and appends the pointer lines after them. That is
 *    what puts the pointers inside the one `<workspace>` tag — the section
 *    arbor-core registers from the workspace — instead of in a second home.
 *  - **`reclaimable`** answers `false`. Arbor 2026.1107.1 asks an implementation
 *    whether it owns the directory it would remove (`Workspace.reclaimable?()`),
 *    and this deployment's answer is no: the workspace a window is handed is
 *    rooted at the shared folder, whose projects are the user's work, so no
 *    retention period may remove one. The host then neither asks which ref to
 *    reclaim nor arms a deadline, and no failure is recorded. Nothing changes
 *    today — no `workspaces.retentionMs` is set — it is the truth stated before
 *    a retention is configured.
 *
 * @param workspace - the workspace `openWorkspace` settled on.
 * @param pointers - where the pointers are read from, or undefined to leave the
 *   implementation's own section exactly as it is.
 */
export function withArborWorkspace(workspace: Workspace, pointers: PointerSource | undefined): Workspace {
  const sectionOf = pointers === undefined
    ? workspace.promptSection?.bind(workspace)
    : (table: TextTable) => {
        const base = workspace.promptSection?.(table)
        // An implementation that contributes no section keeps contributing none.
        return base === undefined ? undefined : withPointerSection(base, pointers)
      }
  return new Proxy(workspace, {
    get(target, property) {
      if (property === 'promptSection') return sectionOf
      if (property === 'reclaimable') return () => false
      const value = Reflect.get(target, property)
      // Methods are forwarded bound to the implementation, so a caller that
      // takes one off the wrapper still runs it against the real workspace.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/**
 * Open arbor's own workspace over the shared folder: ovnfs when its daemon
 * starts, the plain-directory workspace otherwise. The shared folder is created
 * first so ovnfs always has a source and the project bridge always has a home.
 *
 * The workspace that comes back is wrapped by {@link withArborWorkspace} when
 * pointers are named, so its `<workspace>` section answers for the
 * external-project pointers as well as for the method.
 */
export async function openArborWorkspace(options: ArborWorkspaceOptions): Promise<ArborWorkspace> {
  const sharedFolder = arborSharedFolder(options.root, options.source)
  await mkdir(sharedFolder, { recursive: true })
  const result = await openWorkspace({
    source: sharedFolder,
    state: join(options.root, 'ovnfs', 'state'),
    mount: join(options.root, 'ovnfs', 'checkouts'),
    // The plain-directory fallback keeps every window's own directory here, one
    // level beside the shared folder so a window's directory is never mistaken
    // for a project.
    root: join(options.root, 'workspaces'),
    journal: options.journal,
    ...options.bin === undefined ? {} : { bin: options.bin },
    ...options.warn === undefined ? {} : { warn: options.warn },
  })
  return {
    ...result,
    sharedFolder,
    workspace: withArborWorkspace(result.workspace, options.pointers),
  }
}
