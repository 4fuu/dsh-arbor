/**
 * The seam to DSH's sandboxed capabilities: one object that answers what a
 * window's file access and command execution are allowed to do, and runs them.
 *
 * Everything here is a citation of where DSH's own `bash`/`read`/`write`/`edit`
 * get the same answers, at `dsh-v0.2.2-rc.1`:
 *
 *  - `ctx.shell` is the `ShellExecutor` seam (`@deepseek-ai/dsh-shell`,
 *    `lib/types/index.d.ts`), and the shipped `headless` profile mounts the
 *    sandbox-consuming subclass `SandboxBashExecutor`
 *    (`@deepseek-ai/dsh-bash-sandbox`, `lib/types/index.d.ts`): it wraps the
 *    exact argv through `ctx.sandbox` and stamps the run's facts on the result.
 *    The base profile's row is `packages/bundle/base/cordis.patch.yml`
 *    (`- id: bash-sandbox`).
 *  - `ctx.fs` is the `FileSystem` seam (`@deepseek-ai/dsh-fs`,
 *    `lib/types/index.d.ts`), and the same profile mounts
 *    `SandboxedFileSystem` (`@deepseek-ai/dsh-fs-sandbox`,
 *    `lib/types/index.d.ts`, row `- id: fs-sandbox`), which fences all five
 *    mutations by the per-call policy and throws the structured
 *    `FS_SANDBOX_DENIED`.
 *  - The per-call policy is `ctx.sandboxPolicy.resolve({ session })`
 *    (`@deepseek-ai/dsh-sandbox-policy`, `lib/types/index.d.ts`): the session's
 *    last `sandbox/mode` event, else the deployment default, with the session's
 *    immutable cwd as the `workspace-write` root. A direct call that does not
 *    resolve it gets the deployment default instead of the session's — which is
 *    why this seam resolves it, exactly as `dsh-tool-fs`'s `FsSandboxController`
 *    and `dsh-tool-bash`'s `resolveSandboxPolicy` do
 *    (`@deepseek-ai/dsh-tool-fs/lib/index.js`, `resolvePolicy`;
 *     `@deepseek-ai/dsh-tool-bash/lib/index.js`).
 *  - The escalation choreography is `approveEscalation`
 *    (`@deepseek-ai/dsh-sandbox/lib/types/escalation.d.ts`), the ordered
 *    fail-closed sequence both tool families share, with the ask routed through
 *    `ctx.get('approval')` on the calling agent.
 *
 * Nothing in this module touches the host filesystem: no `node:fs`, no
 * `child_process`. That is the whole point — arbor's own file tools reach a
 * window's files only through here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import { ESCALATION_TARGETS, approveEscalation, sandboxDenialMarker, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { arborError } from '@4fu/arbor-errors'
import type { TextArgs } from '@4fu/arbor-prompt'

/**
 * `SandboxBashExecutor.resolve` reads `request.sandboxPolicy` and falls back to
 * the deployment policy when it is absent (`@deepseek-ai/dsh-bash-sandbox`,
 * `lib/index.js`, `resolve`). The published `ShellExecRequest` type does not
 * list the field — a request is the model-facing shape and a policy is resolved
 * by the consumer — so a caller that resolves the session's own policy names it
 * through this widened request type. The runtime reads it.
 */
export type SandboxedShellRequest = ShellExecRequest & {
  readonly sandboxPolicy?: SandboxExecutionPolicy
}

/** One escalation ask, as the seam hands it to DSH's approval. */
export interface EscalationAsk {
  readonly mode: string
  readonly justification: string
  readonly agent: object | undefined
  readonly callId: string
  readonly signal?: AbortSignal
}

/** One command's outcome, as the seam reports it. */
export interface CommandOutcome {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** The sandbox refused a file effect of this command. */
  readonly denied: boolean
}

/**
 * The DSH capabilities one window's file access and commands go through.
 *
 * The object is built once per host from one `Context`, and answers for the
 * session whose turn is running: every method takes the session, so two
 * sessions of different cwds and different modes in one process never see each
 * other's policy.
 */
export class DshSandboxSeam {
  private readonly ctx: Context
  private readonly text: (key: string, args?: TextArgs) => string

  constructor(ctx: Context, text: (key: string, args?: TextArgs) => string) {
    this.ctx = ctx
    this.text = text
  }

  /** Whether this composition confines file effects at all. */
  get confined(): boolean {
    // The capability fact both enforcing families read: `undefined` means the
    // mounted backend never confines (`@deepseek-ai/dsh-fs`,
    // `FileSystem.sandboxMode`; `@deepseek-ai/dsh-shell`,
    // `ShellExecutor.sandboxMode`).
    return this.ctx.fs.sandboxMode !== undefined || this.ctx.shell.sandboxMode !== undefined
  }

  /** The modes a call could escalate to, or none when nothing confines. */
  get escalationModes(): readonly SandboxMode[] {
    return this.confined ? ESCALATION_TARGETS : []
  }

  /**
   * The complete policy one capability call of this session runs under.
   *
   * `ctx.sandboxPolicy.resolve` is what `dsh-tool-fs` and `dsh-tool-bash` call
   * for every mutation and every command, so a window's files and commands are
   * fenced by the same answer DSH's own tools get.
   */
  policyOf(session: Session | undefined): SandboxExecutionPolicy {
    const policy = this.ctx.get('sandboxPolicy') as
      | { resolve(request?: { session?: Session }): SandboxExecutionPolicy }
      | undefined
    if (policy === undefined) {
      throw new Error('dsh-arbor workspace: ctx.sandboxPolicy is missing (load @deepseek-ai/dsh-sandbox-policy)')
    }
    return policy.resolve(session === undefined ? {} : { session })
  }

  /** Where one path names in the backend's execution world. */
  absolute(root: string, path: string): string {
    return path.startsWith('/') ? normalize(path) : `${trimSlash(root)}/${normalize(path)}`
  }

  /** One file's text, or `null` when it is not there. */
  async readText(root: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const target = await this.resolve(root, path, signal)
    if (target === undefined) return null
    try {
      return await this.ctx.fs.readText(target, signal)
    } catch (error: unknown) {
      if (isAbsent(error)) return null
      throw error
    }
  }

  /**
   * One file's text, fenced by this session's policy.
   *
   * The parent directory is created first, through the same sandboxed shell a
   * command runs in, so a write under `read-only` is refused by the policy
   * rather than by a missing directory — and a directory the sandbox refuses is
   * never created.
   */
  async writeText(
    root: string,
    path: string,
    text: string,
    policy: SandboxExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = await this.resolve(root, path, signal)
    if (target === undefined) throw new Error(`dsh-arbor workspace: cannot resolve ${path}`)
    const parent = parentOf(this.absolute(root, path))
    if (parent !== undefined && !(await this.exists(root, parent, signal))) {
      await this.makeDirectory(parent, policy, signal)
    }
    try {
      await this.ctx.fs.writeText(target, text, undefined, signal, policy)
    } catch (error: unknown) {
      throw deny(error, policy, this.text)
    }
  }

  /** Whether one path exists in the backend's execution world. */
  async exists(root: string, path: string, signal?: AbortSignal): Promise<boolean> {
    const target = await this.resolve(root, path, signal)
    if (target === undefined) return false
    return (await this.ctx.fs.stat(target, signal)) !== undefined
  }

  /** One path's size and the file count under it, for a quota. */
  async measure(root: string, path: string): Promise<{ bytes: number; files: number }> {
    const target = await this.resolve(root, path)
    if (target === undefined) return { bytes: 0, files: 0 }
    let bytes = 0
    let files = 0
    const walk = async (at: FsTarget): Promise<void> => {
      const info = await this.ctx.fs.stat(at)
      if (info === undefined) return
      if (info.type === 'file') {
        files += 1
        bytes += info.size ?? 0
        return
      }
      if (info.type !== 'directory') return
      for (const entry of await this.ctx.fs.listDir(at)) await walk(entry.target)
    }
    await walk(target)
    return { bytes, files }
  }

  /** Remove one path's tree, through the sandboxed shell. */
  async remove(root: string, path: string, policy: SandboxExecutionPolicy): Promise<void> {
    const outcome = await this.run(`rm -rf ${quote(this.absolute(root, path))}`, root, policy)
    if (outcome.exitCode !== 0) throw deny(new Error(outcome.stderr.trim()), policy, this.text)
  }

  /**
   * One command, confined by this session's policy, run to its end.
   *
   * `resolve` fills the executor's own defaults and caps; the session's policy
   * is stamped over the result, which is what `dsh-tool-bash` does with the
   * policy its `resolveSandboxPolicy` answered.
   */
  async run(
    command: string,
    workdir: string,
    policy: SandboxExecutionPolicy,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CommandOutcome> {
    const spec = this.ctx.shell.resolve({
      command,
      workdir,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onExpiry: 'kill',
      sandboxPolicy: policy,
    } satisfies SandboxedShellRequest)
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      denied: result.sandbox?.denied === true,
    }
  }

  /** One resolved target, or `undefined` when the backend cannot resolve it. */
  private async resolve(
    root: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FsTarget | undefined> {
    try {
      return await this.ctx.fs.resolve(this.absolute(root, path), { cwd: root, signal })
    } catch {
      return undefined
    }
  }

  /** One directory, created through the sandboxed shell. */
  private async makeDirectory(
    path: string,
    policy: SandboxExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const outcome = await this.run(`mkdir -p ${quote(path)}`, policy.workspaceRoot, policy, { signal })
    if (outcome.exitCode !== 0) {
      throw deny(new Error(outcome.stderr.trim() || `mkdir -p ${path} failed`), policy, this.text)
    }
  }

  /**
   * Ask the user for a wider mode, through DSH's approval, before anything runs.
   *
   * The sequence is `approveEscalation`'s, verbatim: repeating the effective
   * mode needs no approval, a strictly wider mode needs a non-empty
   * justification and a grant, a narrower or unsupported target is refused, and
   * a missing approver, a missing agent or a non-grant outcome fails closed.
   */
  async escalate(ask: EscalationAsk, effectiveMode: SandboxMode): Promise<SandboxMode> {
    if (!this.confined) {
      throw arborError({
        code: 'unavailable',
        rule: 'sandbox_escalate.absent',
        message: this.text('refused.sandbox_escalate.absent'),
        nextAction: this.text('next.sandbox_escalate.absent'),
      })
    }
    validateEscalationArgs(ask.mode, ask.justification)
    const approver = this.ctx.get('approval') as
      | { request(request: Record<string, unknown>): Promise<string> }
      | undefined
    return approveEscalation(
      {
        requestedMode: ask.mode,
        justification: ask.justification,
        effectiveMode,
        subject: 'operation',
      },
      {
        approver: approver as never,
        agent: ask.agent as never,
        callId: ask.callId,
        toolName: 'sandbox_escalate',
        ...(ask.signal === undefined ? {} : { signal: ask.signal }),
      },
    )
  }
}

/**
 * One error a sandboxed mutation threw, as the refusal the model reads.
 *
 * `FS_SANDBOX_DENIED` is the fence's structured refusal
 * (`@deepseek-ai/dsh-fs-sandbox`, `checkedTarget`); `dsh-tool-fs` maps it to the
 * denial marker plus the escalation hint (`mapError`). A window's file tools get
 * the same lines, so the model recognizes the refusal the same way, and the
 * next action names the one sanctioned way forward.
 */
export function deny(
  error: unknown,
  policy: SandboxExecutionPolicy,
  text: (key: string, args?: TextArgs) => string,
): Error {
  const code = (error as { code?: unknown } | null)?.code
  const detail = error instanceof Error ? error.message : String(error)
  if (code === 'FS_SANDBOX_DENIED' || detail.includes('file access denied under')) {
    const next = policy.mode === 'read-only'
      ? text('next.file.denied.readonly')
      : text('next.file.denied.workspace', { root: policy.workspaceRoot })
    return arborError({
      code: 'denied',
      rule: 'sandbox.denied',
      message: text('refused.file.denied', { marker: sandboxDenialMarker(policy.mode), detail }),
      nextAction: next,
    })
  }
  return arborError({ code: 'failed', rule: 'sandbox.failed', message: detail })
}

/** Whether one error means the target is not there. */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'FS_NOT_FOUND' || code === 'FS_NOT_OBSERVED' || code === 'ENOENT'
}

/** The parent directory of one absolute path, or none at the root. */
function parentOf(path: string): string | undefined {
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return undefined
  return path.slice(0, cut)
}

/** One path, normalized without a trailing slash. */
function normalize(path: string): string {
  const collapsed = path.replaceAll(/\/+/g, '/').replace(/\/$/, '')
  return collapsed === '' ? '/' : collapsed
}

/** One path with no trailing slash. */
function trimSlash(path: string): string {
  return path.replace(/\/$/, '')
}

/** One shell argument, quoted for `sh -c`. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
