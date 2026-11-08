/**
 * Proof 22: a cold client restores a blank under the preset its log recorded.
 *
 * A page reload restores the blank session the main view saved, and the shipped
 * restore reads the session's `agentPreset` projection to name the preset at
 * create (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`:
 * `restoreBlank` awaits `sessions.refreshProjections(sessionId)` and reads
 * `byId[sessionId]?.projectionValues?.agentPreset`). That projection is the
 * session header folded with its selection events
 * (`@deepseek-ai/dsh-agent-preset-registry`, `lib/types/session.js`), and it is
 * not a summary key — it declares no `wire.summary` — so the session list's
 * projection blocks never fill it and the only read that does is the Host's
 * own projections read. A read that answers before the session's row is
 * visible, or that fails, leaves the cache cold: the create then names no
 * preset, the controller resolves the deployment default, and an arbor session
 * comes back on the embedded loop.
 *
 * `@4fu/dsh-arbor-ui-workspace` wraps that one method on the service instance
 * and holds the call until the session's own answer is in the cache, against a
 * bounded deadline. This proof drives the shipped plugin's own `apply` against
 * a client that behaves exactly as the shipped code does — the same two lines
 * of `restoreBlank`, the same projections read — and checks:
 *
 *  A. with a cache that is still cold, DSH's own restore names no preset, which
 *     is the shape the downgrade takes;
 *  B. with this package applied, the same restore waits for the session's own
 *     answer and then names it, so the create carries the preset and the
 *     session comes back on arbor;
 *  C. the wait is bounded: a session whose answer never arrives is still
 *     restored, without a preset, exactly as DSH would restore it;
 *  D. nothing else about the request changes — the same workspace, the same
 *     session, one create.
 *
 * Run: pnpm proof:reload-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { finishProof } from '../packages/arbor-testkit/src/index.ts'
import { apply } from '../packages/arbor-ui-workspace/src/client.ts'

const NAME = 'arbor-spike-proof-22'

/** The agent-preset id whose sessions run arbor. */
const ARBOR = 'arbor'

/** Longer than the plugin's own 40ms poll, so its wraps are on before the drive. */
const POLL_WAIT_MS = 80

const uninstallFailLoud = installFailLoud(NAME)
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** One create the client's restore made, as far as this proof reads it. */
interface Create {
  readonly workspaceId: string
  readonly sessionId?: string
  readonly agentPreset?: string
}

/**
 * One cold client: the workspace service's restore exactly as the shipped
 * plugin implements it, the sessions service it reads, and the creates it made.
 *
 * `answeringRead` is the projections read that first answers with the session's
 * own preset. Read 1 answering is the healthy case; read 2 is the cold case the
 * wrap exists for; a number no read reaches is the case where the answer never
 * arrives at all.
 */
function coldClient(answeringRead: number): {
  ctx: Context
  creates: readonly Create[]
  reads: () => number
  navigation: { restoreBlank(workspaceId: string, sessionId: string): Promise<string> }
} {
  const values = new Map<string, { agentPreset?: string }>()
  const creates: Create[] = []
  let reads = 0
  const sessions = {
    list: {
      getSnapshot: (): { byId: Record<string, { projectionValues?: { agentPreset?: string } }> } => ({
        byId: Object.fromEntries(
          [...values].map(([id, projectionValues]) => [id, { projectionValues }]),
        ),
      }),
    },
    refreshProjections: async (sessionId: string): Promise<void> => {
      reads += 1
      if (reads >= answeringRead) values.set(sessionId, { agentPreset: ARBOR })
    },
  }
  const createNamed = (request: Create): string => {
    creates.push(request)
    return request.sessionId ?? 'session-minted'
  }
  const navigation = {
    openWorkspace: (): void => undefined,
    restoreBlank: async (workspaceId: string, sessionId: string): Promise<string> => {
      await sessions.refreshProjections(sessionId)
      const recorded = sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
      const request: Create = { workspaceId, sessionId }
      if (typeof recorded !== 'string') return createNamed(request)
      return createNamed({ ...request, agentPreset: recorded })
    },
  }
  const ctx = {
    get: (name: string): unknown => {
      if (name === 'uiWorkspace') return navigation
      if (name === 'sessions') return sessions
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [] }) } }
      return undefined
    },
    slots: {
      entriesOfSlot: (): readonly { inject?: unknown }[] => [],
      register: (): (() => void) => (): void => undefined,
    },
    effect: (): void => undefined,
    logger: { warn: (): void => undefined },
  }
  return { ctx: ctx as unknown as Context, creates, reads: () => reads, navigation }
}

try {
  // ---- A. the shipped restore with a cache that is still cold.
  const cold = coldClient(2)
  await cold.navigation.restoreBlank('ws-1', 'session-arbor')
  check("DSH's own restore names no preset while its cache is cold",
    cold.creates.length === 1 && cold.creates[0]?.agentPreset === undefined,
    `the create went out as ${JSON.stringify(cold.creates[0])}`)

  // ---- B. the same client with this package's plugin applied.
  const wrapped = coldClient(2)
  apply(wrapped.ctx)
  // The wraps go on when the poll next looks, because the shipped workspace
  // service is registered on its own timeline and this package waits for it.
  await new Promise(resolve => setTimeout(resolve, POLL_WAIT_MS))
  await wrapped.navigation.restoreBlank('ws-1', 'session-arbor')
  check('the restore waits for the recorded answer and then names it',
    wrapped.creates.length === 1 && wrapped.creates[0]?.agentPreset === ARBOR,
    `the create went out as ${JSON.stringify(wrapped.creates[0])}`)
  check('the wait retries the read that answers, rather than reading once',
    wrapped.reads() >= 2,
    `projections reads made: ${wrapped.reads()}`)

  // ---- C. the wait is bounded: a session whose answer never arrives is still
  // restored, and the deadline is spent rather than hung on.
  const never = coldClient(Number.MAX_SAFE_INTEGER)
  apply(never.ctx)
  await new Promise(resolve => setTimeout(resolve, POLL_WAIT_MS))
  const started = Date.now()
  await never.navigation.restoreBlank('ws-1', 'session-arbor')
  const waited = Date.now() - started
  check('a session whose preset never answers is still restored, without one',
    never.creates.length === 1 && never.creates[0]?.agentPreset === undefined,
    `the create went out as ${JSON.stringify(never.creates[0])}`)
  check('the wait is bounded',
    waited >= 1_500 && waited <= 5_000,
    `the restore was held for ${waited}ms`)

  // ---- D. nothing else about the request changes.
  check('the wrapped restore makes the same request the shipped one makes',
    wrapped.creates[0]?.workspaceId === cold.creates[0]?.workspaceId
      && wrapped.creates[0]?.sessionId === cold.creates[0]?.sessionId
      && wrapped.creates.length === 1,
    `wrapped ${JSON.stringify(wrapped.creates[0])}; shipped ${JSON.stringify(cold.creates[0])}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  uninstallFailLoud()
  finishProof('reload-preset', failures)
}
