/**
 * Proof 21: an arbor session belongs to the workspace the user picked, and the
 * shared folder is never a DSH workspace.
 *
 * The b3g live run left the sidebar untrue twice over: a session created for a
 * directory the user added appeared under a workspace named "shared" — arbor's
 * own internal folder, which no user made — and the added directory appeared as
 * a workspace with no sessions in it. The cause is DSH's own membership rule: a
 * workspace's `sessionIds` are filtered by the session's stored cwd
 * (`@deepseek-ai/dsh-workspace`, `WorkspaceEntity.sessionIds` ->
 * `candidateMatches` -> `sessionPaths.get(id) === path`), and
 * `Workspace.attachSession` refuses a session whose cwd is not the workspace's
 * path ("its cwd resolves to …"). b3g answered that by resolving every arbor
 * session's cwd into the shared folder and registering the shared folder as a
 * workspace, which is what produced the "shared" row.
 *
 * So the cwd is no longer moved: `DshProjectBridge.resolveProject` answers the
 * directory the caller named, and `attachWorkspace` attaches the session to the
 * workspace that owns that directory — registering one only for a project
 * subfolder of the shared folder, and never for the shared folder itself.
 *
 *  A. a session created in a project of the shared folder is a member of that
 *     project's workspace, and the shared folder is not registered;
 *  B. a session created in a directory the user added is a member of that
 *     directory's workspace — the one DSH's own add-workspace action created —
 *     and it records the external pointer;
 *  C. a session created in the shared folder itself belongs to no workspace and
 *     registers none, so no row names arbor's internal folder;
 *  D. a directory outside the shared folder that nobody added is never
 *     registered by this bridge, so the project list gains no row for it.
 *
 * Run: pnpm proof:arbor-workspace-membership
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  arborPatch,
  bootArborProfile,
  finishProof,
  freshDshHome,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-21'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))

type ProofContext = Awaited<ReturnType<typeof bootArborProfile>>

const uninstallFailLoud = installFailLoud(NAME)
let ctx: ProofContext | undefined
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/**
 * A workspace registry that behaves the way DSH's own does about membership:
 * `attachSession` refuses a session whose cwd is not the workspace's path, and
 * `sessionIds` only names sessions whose cwd matches. The b3g code attached a
 * session to whatever workspace it resolved the cwd into, which only worked
 * because it also moved the cwd there; this stub is what proves the new code
 * does not rely on that.
 */
class WorkspaceRegistryStub extends Service {
  /** Every path registered through `create`, in order. */
  readonly created: string[] = []
  /** The sessions each registered path holds, and the cwd each one resolved to. */
  private readonly members = new Map<string, Map<string, string>>()
  /** The title each registered path was created with. */
  private readonly titles = new Map<string, string>()

  constructor(context: Context) {
    super(context, 'workspaceRegistry')
  }

  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = resolve(path)
    if (!this.created.includes(canonical)) this.created.push(canonical)
    if (!this.members.has(canonical)) this.members.set(canonical, new Map())
    if (title !== undefined && !this.titles.has(canonical)) this.titles.set(canonical, title)
    return this.workspaceOf(canonical, title)
  }

  list(): readonly Workspace[] {
    return this.created.map(path => this.workspaceOf(path))
  }

  /** The workspace whose path the session's cwd names, which is DSH's answer. */
  workspaceOfSession(sessionId: SessionId, cwd: string | undefined): Workspace | undefined {
    if (cwd === undefined) return undefined
    const path = resolve(cwd)
    return this.members.has(path) ? this.workspaceOf(path) : undefined
  }

  private workspaceOf(path: string, title?: string): Workspace {
    const members = this.members.get(path) ?? new Map<string, string>()
    return {
      id: WorkspaceId(`workspace-${path}`),
      path,
      title: title ?? this.titles.get(path) ?? path.slice(path.lastIndexOf('/') + 1),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // DSH filters by cwd: a session whose cwd is not this path is not a
      // member, whatever the record says.
      get sessionIds(): readonly string[] {
        return [...members.entries()].filter(([, cwd]) => resolve(cwd) === path).map(([id]) => id)
      },
      setTitle: async () => {},
      attachSession: async (sessionId: SessionId) => {
        const cwd = this.headerCwd(sessionId)
        if (cwd === undefined) throw new Error(`cannot attach session '${sessionId}' to workspace '${path}': its stored header carries no cwd`)
        if (resolve(cwd) !== path) {
          throw new Error(`cannot attach session '${sessionId}' to workspace '${path}': its cwd resolves to '${cwd}'`)
        }
        members.set(sessionId, cwd)
      },
      insertSessionBefore: async () => {},
      detachSession: async (sessionId: SessionId) => { members.delete(sessionId) },
      status: async () => 'ok',
    } as unknown as Workspace
  }

  /** The cwd a session was created with, as DSH reads it from the stored header. */
  private headerCwd(sessionId: SessionId): string | undefined {
    const agent = ctx?.agents.get(sessionId) as Agent | undefined
    return agent?.session.header.cwd
  }
}

/** One session created the way the session controller creates one. */
async function createSession(cwd: string, preset?: string): Promise<Agent> {
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = { ...SCRIPTED_SELECTION }
  const { agent } = await ctx!.agents.create({
    sessionId,
    meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  return agent
}

/** Drive one session for one turn and wait for it to settle. */
async function turn(agent: Agent, text = 'say pong'): Promise<void> {
  scriptedLlm.responses = [{ text: 'pong' }]
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Wait until one call answers something other than undefined, or give up. */
async function waitFor<T>(read: () => T | undefined, limit = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + limit
  for (;;) {
    const found = read()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay],
    // The registry is a stand-in because the durable one is a web-profile row.
    // It is mounted before the host's own rows activate, so the host's injected
    // child attaches the project bridge to it the way the web profile's does.
    prepare: async (root) => {
      await root.plugin(WorkspaceRegistryStub)
    },
  })
  const host = arborHostOf(ctx)
  const registry = (ctx as unknown as { workspaceRegistry: WorkspaceRegistryStub }).workspaceRegistry
  const shared = host.sharedFolder
  check('the stand-in registry is mounted', registry !== undefined,
    `ctx.workspaceRegistry -> ${registry === undefined ? 'absent' : 'present'}`)

  // ---- A. a project of the shared folder is the session's workspace.
  const project = join(shared, 'web-app')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'index.html'), '<h1>web app</h1>', 'utf8')
  const inProject = await createSession(project, 'arbor')
  await turn(inProject)
  const projectWorkspace = await waitFor(() => registry.workspaceOfSession(inProject.id, inProject.session.header.cwd))
  check('a session created in a project is a member of that project',
    projectWorkspace !== undefined && projectWorkspace.sessionIds.includes(inProject.id),
    `workspace: ${projectWorkspace?.path ?? '(none)'}; members: ${projectWorkspace?.sessionIds.join(', ') ?? '(none)'}`)
  check('the shared folder itself is not registered as a workspace',
    !registry.created.includes(resolve(shared)),
    `registered paths: ${registry.created.join(', ')}`)

  // ---- B. a directory the user added is the session's workspace, and the
  // pointer is recorded for it.
  const added = await mkdtemp(join(tmpdir(), 'arbor-added-'))
  await writeFile(join(added, 'main.py'), 'print("mine")', 'utf8')
  // The add-workspace action's own registration, the way the shipped flow does
  // it before the picker picks the directory.
  await registry.create(added, 'added')
  const inAdded = await createSession(added, 'arbor')
  await turn(inAdded)
  const addedWorkspace = await waitFor(() => registry.workspaceOfSession(inAdded.id, inAdded.session.header.cwd))
  check('a session created in an added directory is a member of it',
    addedWorkspace !== undefined && addedWorkspace.sessionIds.includes(inAdded.id),
    `workspace: ${addedWorkspace?.path ?? '(none)'}; members: ${addedWorkspace?.sessionIds.join(', ') ?? '(none)'}`)
  check('the added directory keeps its own title',
    addedWorkspace?.title === 'added',
    `title: ${String(addedWorkspace?.title ?? '')}`)
  check('the session in the added directory names it as an external pointer',
    (await host.listArborPointers(inAdded.id)).some(pointer => pointer.path === resolve(added)),
    `pointers: ${JSON.stringify(await host.listArborPointers(inAdded.id))}`)
  check('the session created in the added directory keeps that directory as its cwd',
    inAdded.session.header.cwd === resolve(added),
    `cwd: ${inAdded.session.header.cwd}`)

  // ---- C. a session created in the shared folder itself belongs to nothing and
  // registers nothing, so no row names arbor's internal folder.
  const inShared = await createSession(shared, 'arbor')
  await turn(inShared)
  check('a session created in the shared folder registers no workspace for it',
    !registry.created.includes(resolve(shared)),
    `registered paths: ${registry.created.join(', ')}`)
  check('the shared-folder session belongs to no workspace',
    registry.workspaceOfSession(inShared.id, inShared.session.header.cwd) === undefined,
    `workspace: ${String(registry.workspaceOfSession(inShared.id, inShared.session.header.cwd)?.path ?? '(none)')}`)

  // ---- D. a directory nobody added is never registered by this bridge.
  const inherited = await mkdtemp(join(tmpdir(), 'arbor-inherited-'))
  await writeFile(join(inherited, 'notes.md'), 'the inherited cwd', 'utf8')
  const inInherited = await createSession(inherited, 'arbor')
  await turn(inInherited)
  check('a directory nobody added is not registered as a workspace',
    !registry.created.includes(resolve(inherited)),
    `registered paths: ${registry.created.join(', ')}`)
  check('the inherited directory is not an external pointer',
    (await host.listArborPointers(inInherited.id)).length === 0,
    `pointers: ${JSON.stringify(await host.listArborPointers(inInherited.id))}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstallFailLoud()
  finishProof('arbor-workspace-membership', failures)
}
