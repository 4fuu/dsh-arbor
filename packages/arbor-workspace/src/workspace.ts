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
 * taking over DSH's project management.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openWorkspace, type OpenWorkspaceResult, type WorkspaceBackend } from '@4fu/arbor-core'
import type { Journal, Workspace } from '@4fu/arbor-interfaces'

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
 * Open arbor's own workspace over the shared folder: ovnfs when its daemon
 * starts, the plain-directory workspace otherwise. The shared folder is created
 * first so ovnfs always has a source and the project bridge always has a home.
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
  return { ...result, sharedFolder }
}
