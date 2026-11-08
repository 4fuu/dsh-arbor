/**
 * Proof 16: a directory added through DSH's own add-workspace action becomes a
 * pointer for the arbor session that asked for it.
 *
 * The owner's rule for the pointer is that it is recorded where an arbor session
 * asked for it and nowhere else, and the ask has to travel a path DSH already
 * has: no new verb, no client change. The path is the client's add-workspace
 * action, which calls the `workspace/create` remote verb
 * (`@deepseek-ai/dsh-api-workspace-controller`, `create`), which is the one
 * caller of `WorkspaceRegistry.create` in a DSH installation besides the project
 * bridge's own sync. So this proof mounts a stand-in registry — the durable
 * `WorkspaceRegistry` is a web-profile row, and the headless profile has none —
 * registers a directory through `create` exactly as that verb does, and checks
 * what follows:
 *
 *  A. the directory is remembered as one the user added, and a project subfolder
 *     of the shared folder (which the bridge registers itself) is not;
 *  B. an arbor session that names the added directory gets a pointer for it, in
 *     the `<workspace>` section its own window opens with — both when it is
 *     created under arbor and when it picks arbor afterwards, which is the path
 *     the web hero takes;
 *  C. an arbor session that names a directory nobody added gets no pointer, so a
 *     cwd a session merely inherited never becomes one;
 *  D. the pointer belongs to the session that asked: another arbor session's
 *     window does not name it.
 * Run: pnpm proof:external-project
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'
import {
  SCRIPTED_SELECTION,
  arborHostOf,
  finishProof,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'

const NAME = 'arbor-spike-proof-16'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
// The roster a deployment with a preset picker has, so the pick can be committed
// the way the web hero commits it.
const presetOverlay = fileURLToPath(new URL('../patches/preset-registry.patch.yml', import.meta.url))

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/**
 * A stand-in for DSH's durable `WorkspaceRegistry`, which only the web profile
 * mounts. It answers what the bridge reads — `create(path, title)` — the way the
 * registry does: the canonical path and the title the caller named, so the
 * bridge sees exactly what the `workspace/create` verb would have handed it.
 * The service key is the registry's own, which is what makes the host's
 * injected child attach this bridge to it.
 */
class WorkspaceRegistryStub extends Service {
  /** Every path registered through `create`, in order. */
  readonly created: string[] = []

  constructor(context: Context) {
    super(context, 'workspaceRegistry')
  }

  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = resolve(path)
    this.created.push(canonical)
    return {
      id: WorkspaceId(randomUUID()),
      path: canonical,
      title: title ?? basename(canonical),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [],
      setTitle: async () => {},
      attachSession: async () => {},
      insertSessionBefore: async () => {},
      detachSession: async () => {},
      status: async () => 'ok',
    } as unknown as Workspace
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

/** The `<workspace>` section one session's window opened with. */
function workspaceOf(sessionId: SessionId): string {
  const driver = ctx!.get('arborDriver') as { systemPromptOf(id: SessionId): string | undefined }
  const prompt = driver.systemPromptOf(sessionId) ?? ''
  return /<workspace>([\s\S]*?)<\/workspace>/.exec(prompt)?.[1] ?? ''
}

/** Drive one session for one turn and wait for it to settle. */
async function turn(agent: Agent, text = 'say pong'): Promise<void> {
  scriptedLlm.responses = [{ text: 'pong' }]
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

try {
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  let registry: WorkspaceRegistryStub | undefined
  ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, presetOverlay],
    // The registry is a stand-in because the durable one is a web-profile row.
    // It is mounted before the host's own rows activate, so the host's injected
    // child attaches the project bridge to it the way the web profile's does.
    prepare: async (root) => {
      await root.plugin(WorkspaceRegistryStub)
      registry = root.get('workspaceRegistry') as WorkspaceRegistryStub | undefined
    },
  })
  const host = arborHostOf(ctx)
  const shared = host.sharedFolder

  // ---- A. the add-workspace action's directory is remembered; a project is not.
  const added = await mkdtemp(join(tmpdir(), 'arbor-added-'))
  await writeFile(join(added, 'main.py'), 'print("mine")', 'utf8')
  const project = join(shared, 'web-app')
  check('the stand-in registry is mounted', registry !== undefined,
    `ctx.workspaceRegistry -> ${registry === undefined ? 'absent' : 'present'}`)
  await registry!.create(added)
  await registry!.create(project)
  check('a directory the user added is remembered',
    host.isAddedArborDirectory(added),
    `added: ${host.isAddedArborDirectory(added)}`)
  check('a project of the shared folder is not a user-added directory',
    !host.isAddedArborDirectory(project),
    `the shared folder's own project counts as added: ${host.isAddedArborDirectory(project)}`)

  // ---- B. the arbor session that names it gets a pointer for it.
  const picked = await createSession(added)
  const presets = (ctx as unknown as { agentPresets?: { select(agent: Agent, id: string): Promise<string> } }).agentPresets
  await presets!.select(picked, 'arbor')
  let rerouted: Agent | undefined
  for (let attempt = 0; attempt < 100 && (rerouted === undefined || rerouted === picked); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    rerouted = ctx.agents.get(picked.id)
  }
  await turn(rerouted!)
  const pickedWorkspace = workspaceOf(picked.id)
  check("the session that picked arbor names the added directory in its own <workspace>",
    pickedWorkspace.includes(`外部项目 ${basename(added)}：${added}`),
    `<workspace> names the added directory: ${pickedWorkspace.includes(added)}`)

  // The same rule on the path that names arbor at creation.
  const created = await createSession(added, 'arbor')
  await turn(created)
  check('a session created under arbor names the added directory too',
    workspaceOf(created.id).includes(`外部项目 ${basename(added)}：${added}`),
    `<workspace> names the added directory: ${workspaceOf(created.id).includes(added)}`)

  // ---- C. a cwd nobody added never becomes a pointer. The section is checked
  // for arbor's own method lines as well, so an empty section — a window that
  // never opened — cannot pass for a window without a pointer.
  const inherited = await mkdtemp(join(tmpdir(), 'arbor-inherited-'))
  await writeFile(join(inherited, 'notes.md'), 'the inherited cwd', 'utf8')
  const plain = await createSession(inherited, 'arbor')
  await turn(plain)
  const plainWorkspace = workspaceOf(plain.id)
  check('an arbor session whose cwd nobody added has no pointer',
    plainWorkspace.includes('workspace.keep') && !plainWorkspace.includes(inherited)
      && !plainWorkspace.includes('外部项目'),
    `<workspace> names the inherited directory: ${plainWorkspace.includes(inherited)}`)

  // ---- D. the pointer belongs to the session that asked for it.
  const other = await createSession(shared, 'arbor')
  await turn(other)
  const otherWorkspace = workspaceOf(other.id)
  check("another arbor session's window does not name it",
    otherWorkspace.includes('workspace.keep') && !otherWorkspace.includes(added),
    `the other session's <workspace> names the added directory: ${otherWorkspace.includes(added)}`)

  // The bridge's own registration of the shared folder's projects never counts
  // as a user-added directory, so a session created in a project folder has no
  // pointer either.
  await mkdir(project, { recursive: true })
  const inProject = await createSession(project, 'arbor')
  await turn(inProject)
  const projectWorkspace = workspaceOf(inProject.id)
  check('a session in a shared-folder project has no pointer',
    projectWorkspace.includes('workspace.keep') && !projectWorkspace.includes('外部项目'),
    `<workspace> of a project session names a pointer: ${projectWorkspace.includes('外部项目')}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  await ctx?.fiber.dispose().catch(() => {})
  uninstallFailLoud()
  finishProof('external-project', failures)
}
