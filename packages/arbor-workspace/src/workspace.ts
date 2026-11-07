/**
 * The arbor `Workspace` of a DSH session: the session's own working directory,
 * with every file access and every command running through DSH's sandboxed
 * filesystem and shell (docs/workspaces.md).
 *
 * ## What the workspace is
 *
 * The shared root is the DSH session's cwd — the directory the user pointed the
 * session at, and the directory DSH's own `read`/`write`/`edit`/`bash` resolve
 * relative paths against (`ctx.workingDirectory.ensure`,
 * `@deepseek-ai/dsh-working-directory`). Arbor's file tools work in the same
 * place, so a window and the DSH session it belongs to see one tree.
 *
 * There is no per-window subdirectory and no checkout: DSH's sandbox is the
 * boundary, so the isolation arbor's own workspaces provide by copying files is
 * not needed, and a directory per window inside the user's project would only
 * be litter. A window's ref is still a stable handle — `ws<window number>` — so
 * the journal can name which workspace a window's chain has.
 *
 * ## Why nothing here touches the host filesystem
 *
 * Arbor's own `bash`, `read`, `write` and `edit` are the core's
 * (`@4fu/arbor-tools`, `groups/files.js`) and they reach a window's files only
 * through the `Workspace` interface: `WorkspaceMount.exec` when the
 * implementation owns the execution environment, `readFile`/`writeFile` when it
 * can hand a file to the host, and `mount.path` only when it has neither. This
 * implementation provides all three, so:
 *
 *  - a command runs through `ctx.shell`, the seam `dsh-tool-bash` uses, wrapped
 *    by `SandboxBashExecutor` under the session's resolved policy;
 *  - a read runs through `ctx.fs.readText`, which every mode permits;
 *  - a write runs through `ctx.fs.writeText`, fenced by `SandboxedFileSystem`
 *    per call, so `read-only` refuses it with `FS_SANDBOX_DENIED` and
 *    `workspace-write` refuses a path outside the session's cwd.
 *
 * B1's implementation gave every window a `DirectoryWorkspace` under the root,
 * whose file tools then used `node:fs` and `spawn('/bin/sh')` on the host — DSH's
 * file policy did not apply to them at all. This one replaces it.
 *
 * ## Why ovnfs is not offered here
 *
 * Arbor's default workspace when the `ovnfs` binary is found is the ovnfs
 * workspace: one shared folder read-only by convention, a copy-on-write
 * checkout per window, and `checkout`/`apply`/`status` that run the ovnfs CLI
 * as a host subprocess. It cannot sit on top of this one:
 *
 *  - its `mount.readFile`/`writeFile` are `node:fs` calls on the host
 *    (`@4fu/arbor-workspace-ovnfs`, `ovnfs.js`, `mount`), so DSH's per-call
 *    fence never sees them;
 *  - its mount carries no `exec`, so a command would run on the host through
 *    arbor's own `spawn('/bin/sh')` — outside `ctx.shell` and outside the
 *    sandbox entirely;
 *  - its checkout operations spawn the ovnfs binary directly, which is a
 *    process DSH's sandbox does not wrap and cannot account for.
 *
 * Its isolation is redundant here — DSH's sandbox already bounds file effects —
 * and its host-side subprocesses would be a hole straight through that sandbox.
 * So the ovnfs workspace is simply not mounted inside DSH; this implementation
 * is what the host runs instead.
 */

import type {
  Journal,
  PromptSection,
  TextTable,
  ToolGroup,
  WindowRef,
  Workspace,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from '@4fu/arbor-interfaces'
import { arborError } from '@4fu/arbor-errors'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { DshSandboxSeam } from './seam.ts'
import { DshWorkspaceGroup } from './group.ts'
import { dshWorkspaceSection, dshWorkspaceTable, dshWorkspaceTextOf } from './text.ts'

/** The target prefix that names the DSH session a window belongs to. */
const SESSION_TARGET_PREFIX = 'dsh:session:'

/** One approved wider mode, and the standing mode it was granted over. */
interface Grant {
  readonly mode: SandboxMode
  readonly from: SandboxMode
}

/** What this implementation needs from the host that owns it. */
export interface DshWorkspaceOptions {
  /** The seam to DSH's sandboxed filesystem and shell. */
  readonly seam: DshSandboxSeam
  /** The journal, which records which session a window belongs to. */
  readonly journal: Journal
  /** The cwd one DSH session runs in, as the driver noted it. */
  readonly cwdOf: (sessionId: SessionId) => string | undefined
  /** The agent one session id names, when it is live. */
  readonly agentOf: (sessionId: SessionId) => Agent | undefined
  /** The agent whose turn is running, when one is. */
  readonly currentAgent: () => Agent | undefined
  /**
   * Every cwd a live or persisted session runs in, oldest noted first.
   *
   * A window a restart continued has no live session when the host freezes its
   * prefix — `Arbor.start` continues it with no turn in flight — so the root
   * that stands then is the newest one any session is known to run in.
   */
  readonly knownRoots: () => readonly string[]
}

export class DshSandboxWorkspace implements Workspace {
  private readonly seam: DshSandboxSeam
  private readonly journal: Journal
  private readonly cwdOf: (sessionId: SessionId) => string | undefined
  private readonly agentOf: (sessionId: SessionId) => Agent | undefined
  private readonly currentAgent: () => Agent | undefined
  private readonly knownRoots: () => readonly string[]
  /** The approved wider mode one session asked for, with what it was granted over. */
  private readonly grants = new Map<SessionId, Grant>()
  /** The root the last session to run noted, for a render outside any turn. */
  private lastRoot: string | undefined

  /** This implementation's own fixed strings, merged over the framework's. */
  readonly text: TextTable = dshWorkspaceTable

  constructor(options: DshWorkspaceOptions) {
    this.seam = options.seam
    this.journal = options.journal
    this.cwdOf = options.cwdOf
    this.agentOf = options.agentOf
    this.currentAgent = options.currentAgent
    this.knownRoots = options.knownRoots
  }

  // ---- the roots --------------------------------------------------------

  /** The DSH session one window belongs to, from the journal's own record. */
  private async sessionOfWindow(window: WindowRef): Promise<SessionId | undefined> {
    const page = await this.journal.list({ window, kinds: ['window_start'], limit: 1 })
    const target = page.items[0]?.targets.find(one => one.startsWith(SESSION_TARGET_PREFIX))
    return target === undefined ? undefined : target.slice(SESSION_TARGET_PREFIX.length) as SessionId
  }

  /** The root one window's session works in. */
  private async rootOfWindow(window: WindowRef): Promise<string> {
    const session = await this.sessionOfWindow(window)
    const root = session === undefined ? undefined : this.cwdOf(session)
    return root ?? this.lastRoot ?? process.cwd()
  }

  /**
   * The root the session whose turn is running works in.
   *
   * Outside a turn — which is where the host freezes a continued window's
   * prefix, in `Arbor.start` — the newest cwd any session is known to run in
   * stands, and the process's own directory only when nothing is known at all.
   */
  private currentRoot(): string {
    const session = this.currentAgent()?.session
    const root = session === undefined ? undefined : this.cwdOf(session.id)
    if (root !== undefined) {
      this.lastRoot = root
      return root
    }
    const newest = this.knownRoots().at(-1)
    if (newest !== undefined) {
      this.lastRoot = newest
      return newest
    }
    return this.lastRoot ?? process.cwd()
  }

  /** The root one window ref names, for the `workspace.path` answer. */
  async rootOf(window: WindowRef): Promise<string | undefined> {
    const session = await this.sessionOfWindow(window)
    if (session === undefined) return undefined
    return this.cwdOf(session)
  }

  // ---- the Workspace interface ------------------------------------------

  /**
   * The window's workspace ref. Nothing is created: the workspace is the
   * session's own directory, which exists before any window does.
   */
  async create(window: WindowRef): Promise<WorkspaceRef> {
    const root = await this.rootOfWindow(window)
    this.lastRoot = root
    return `ws${windowNumber(window)}` as WorkspaceRef
  }

  /**
   * The workspace, read-write, at the session's own directory.
   *
   * All three capabilities the mount can own are provided, which is what keeps
   * every file access and every command inside DSH's sandbox: `exec` runs a
   * command through `ctx.shell`, `readFile` and `writeFile` through `ctx.fs`.
   */
  async mount(ref: WorkspaceRef): Promise<WorkspaceMount> {
    const root = await this.rootOfRef(ref)
    const seam = this.seam
    return {
      ref,
      path: root,
      exec: async (command: string) => {
        const outcome = await seam.run(command, root, this.policyFor())
        return {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          truncated: false,
        }
      },
      readFile: async (path: string) => seam.readText(root, path),
      writeFile: async (path: string, text: string) => {
        await seam.writeText(root, path, text, this.policyFor())
      },
      release: async () => {},
    }
  }

  /** The session directory's size and file count. */
  async quota(workspace: WorkspaceRef): Promise<WorkspaceQuota> {
    const root = await this.rootOfRef(workspace)
    const measured = await this.seam.measure(root, root)
    return { bytes: measured.bytes, used: measured.bytes, files: measured.files }
  }

  /**
   * Refuse to reclaim. The workspace is the session's own working directory —
   * the user's project — so there is nothing here to remove and removing it
   * would delete work that is not arbor's. The host only calls this when a
   * deployment sets `workspaces.retentionMs`, which this one does not.
   */
  async reclaim(): Promise<void> {
    throw arborError({
      code: 'invalid',
      rule: 'workspace.reclaim.refused',
      message: dshWorkspaceTextOf('refused.workspace.reclaim'),
      nextAction: dshWorkspaceTextOf('next.workspace.reclaim'),
    })
  }

  /** The workspace a window's chain has. It always has one: the session's cwd. */
  async refOf(window: WindowRef): Promise<WorkspaceRef | undefined> {
    if (windowNumber(window) <= 0) return undefined
    const session = await this.sessionOfWindow(window)
    return session === undefined ? undefined : `ws${windowNumber(window)}` as WorkspaceRef
  }

  /** The directory a window works in, for the file tools. */
  async pathOfWindow(window: WindowRef): Promise<string | undefined> {
    return this.rootOfWindow(window)
  }

  // ---- what this implementation adds ------------------------------------

  /**
   * What this implementation adds to the catalog: the escalation tool, and
   * another window's directory by its window.
   */
  groups(table: TextTable): readonly ToolGroup[] {
    return [new DshWorkspaceGroup(this, table)]
  }

  /**
   * This implementation's own prompt text: the workspace is the session's cwd,
   * every file access and command runs through DSH's sandbox under the session's
   * own mode, and the one way to a wider mode is the escalation tool.
   */
  promptSection(): PromptSection {
    return dshWorkspaceSection(() => ({ root: this.currentRoot(), mode: this.modeOf() }))
  }

  /** The mode a window's file access and commands run under, for the prompt. */
  modeOf(): string {
    const agent = this.currentAgent()
    const standing = this.seam.policyOf(agent?.session).mode
    if (agent === undefined) return standing
    const grant = this.grants.get(agent.session.id)
    return grant === undefined || grant.from !== standing ? standing : grant.mode
  }

  // ---- the escalation ---------------------------------------------------

  /**
   * Ask the user for a wider sandbox mode, through DSH's approval, and record
   * the grant for the session that asked.
   *
   * The choreography is DSH's own: `approveEscalation` with `ctx.get('approval')`
   * on the session's agent, the same sequence `dsh-tool-fs` runs for a
   * `sandbox_permissions` argument. The difference is what the answer applies
   * to: arbor's `write`, `edit` and `bash` carry no per-call permission argument
   * — their schemas are the core's — so the grant is recorded for the session
   * rather than for one call, and it is dropped as soon as the session's
   * standing mode moves (a UI switch, or a `sandbox/mode` event), so the mode a
   * window runs under is never wider than the user last agreed to.
   */
  async escalate(window: WindowRef, callId: string, mode: string, justification: string): Promise<SandboxMode> {
    const session = await this.sessionOfWindow(window)
    const agent = (session === undefined ? undefined : this.agentOf(session)) ?? this.currentAgent()
    const standing = this.seam.policyOf(agent?.session)
    // The closed target vocabulary, checked before the ask: `read-only` is the
    // floor and nothing escalates to it (`ESCALATION_TARGETS`,
    // `@deepseek-ai/dsh-sandbox`), and a name outside the vocabulary is a
    // malformed ask rather than one the user should be shown.
    if (!this.seam.escalationModes.includes(mode as SandboxMode)) {
      throw this.refusalOf(new Error(`unknown escalation target: ${mode}`), mode, standing.mode)
    }
    let granted: SandboxMode
    try {
      granted = await this.seam.escalate(
        { mode, justification, agent: agent as object | undefined, callId },
        standing.mode,
      )
    } catch (error: unknown) {
      throw this.refusalOf(error, mode, standing.mode)
    }
    if (agent !== undefined) this.grants.set(agent.session.id, { mode: granted, from: standing.mode })
    return granted
  }

  /**
   * One escalation DSH refused, in this implementation's own words.
   *
   * `approveEscalation` answers in English and in the plain `Error` shape,
   * because it is shared by every tool family; a window reads the Chinese
   * refusal the deployment's text table carries, with the next action that
   * names what to do instead.
   */
  private refusalOf(error: unknown, mode: string, standing: SandboxMode): Error {
    const detail = error instanceof Error ? error.message : String(error)
    const rule = escalationRule(detail, mode)
    return arborError({
      code: rule === 'sandbox_escalate.rejected' ? 'denied' : 'invalid',
      rule,
      message: dshWorkspaceTextOf(`refused.${rule}`, { mode, current: standing }),
      nextAction: dshWorkspaceTextOf(`next.${rule}`),
    })
  }

  /** The policy one capability call of the running session's window runs under. */
  private policyFor(): ReturnType<DshSandboxSeam['policyOf']> {
    const agent = this.currentAgent()
    const standing = this.seam.policyOf(agent?.session)
    if (agent === undefined) return standing
    const grant = this.grants.get(agent.session.id)
    if (grant === undefined || grant.from !== standing.mode) return standing
    return { ...standing, mode: grant.mode }
  }

  /** The root one workspace ref lives under, learned from its window. */
  private async rootOfRef(ref: WorkspaceRef): Promise<string> {
    const window = windowOfRef(ref)
    return window === undefined ? this.currentRoot() : this.rootOfWindow(window)
  }
}

/** The window number one window ref carries, or 0 when it carries none. */
function windowNumber(window: WindowRef): number {
  return Number(/^c(\d+)$/.exec(window)?.[1] ?? 0)
}

/** The window one workspace ref names, when its shape says so. */
function windowOfRef(ref: WorkspaceRef): WindowRef | undefined {
  const number = /^ws(\d+)$/.exec(ref)?.[1]
  return number === undefined ? undefined : `c${number}` as WindowRef
}

/**
 * The refusal rule one escalation answer carries.
 *
 * `approveEscalation` throws plain `Error`s whose text is its own
 * (`@deepseek-ai/dsh-sandbox/lib/index.js`): a pairing problem, a mode that is
 * not strictly wider, a non-grant outcome, or a missing approver or agent. The
 * rule is read off that text, which is the one thing about the answer a
 * deployment may rely on.
 */
function escalationRule(detail: string, mode: string): string {
  if (detail.includes('requires a justification') || detail.includes('justification is only valid')) {
    return 'sandbox_escalate.justification'
  }
  if (detail.includes('not strictly wider')) return 'sandbox_escalate.narrower'
  if (detail.includes('the user rejected')) return 'sandbox_escalate.rejected'
  if (detail.includes('was cancelled')) return 'sandbox_escalate.cancelled'
  if (detail.includes('no approval') || detail.includes('no agent to route')) {
    return 'sandbox_escalate.unavailable'
  }
  if (detail.includes('non-empty sentence')) return 'sandbox_escalate.justification'
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') return 'sandbox_escalate.mode'
  return 'sandbox_escalate.failed'
}
