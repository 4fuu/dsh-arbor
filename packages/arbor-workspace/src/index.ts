/**
 * @4fu/dsh-arbor-workspace — arbor's own workspace over the shared folder, and
 * the DSH project bridge.
 *
 * For arbor sessions arbor's tools run on the host the way they do in standalone
 * arbor, so the workspace is arbor's own: ovnfs when its daemon starts, the
 * plain-directory workspace otherwise, both rooted at the arbor shared folder
 * under `DSH_HOME/arbor`. There is no DSH sandbox seam here, no `sandbox_escalate`
 * and no `fileToolsSandboxed`; the `<workspace>` section and the `workspace.*`
 * module functions are arbor's own.
 *
 * `DshProjectBridge` is the other half of arbor taking over DSH's project
 * management: it makes the shared folder's project subfolders the DSH project
 * list (`ctx.workspaceRegistry`), and it records an existing directory with its
 * own path as an external pointer (name and absolute path, no copy) that
 * arbor's prompt names, rather than adopting it into the shared folder.
 */

export {
  openArborWorkspace,
  arborSharedFolder,
  withArborWorkspace,
  type ArborWorkspace,
  type ArborWorkspaceOptions,
} from './workspace.ts'
export {
  withPointerSection,
  POINTER_BLOCKS,
  POINTER_TEXT,
  type PointerSource,
} from './section.ts'
export {
  DshProjectBridge,
  type DshProject,
  type DshProjectBridgeOptions,
  type ExternalPointer,
} from './projects.ts'
