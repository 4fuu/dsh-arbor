/**
 * The dsh-arbor browser package for the project picker.
 *
 * Arbor's decision reverses part of B3: for arbor sessions arbor takes over
 * DSH's project management, and a DSH project is a project subfolder of arbor's
 * shared folder. That makes the shared folder's projects appear in DSH's own
 * project picker for every session — including an ordinary one, whose tools run
 * inside DSH's sandbox and whose cwd inside the shared folder would write into
 * ovnfs's source. The owner's decision is that an ordinary session does not list
 * them at all, and that an arbor session lists them plus the directories the
 * user added outside them, marked as external.
 *
 * ## The seam: wrap `ctx.slots.register`, not the seat
 *
 * The picker seat (`conversation.hero.workspace`) cannot be shadowed. It declares
 * a child slot (`conversation.hero.workspace.directoryFlow`), and DSH's
 * `SlotCore.register` refuses any registration that re-declares an
 * already-declared child key (`@deepseek-ai/dsh-client-ui-slots`, `lib/index.js`,
 * the frontend bundle's `SlotCore`), so an occupant registered without the
 * children table gets no `renderSlot`, throws, and is abdicated — the same trap
 * the permission seat has, except that here carrying the declaration over is what
 * throws. Neither side offers another seam: `WorkspaceRegistry.list()` /
 * `get()` / `resolveByPath()` are process-global and take no caller
 * (`@deepseek-ai/dsh-workspace`), and `WorkspaceController.follow` filters only
 * by remote peer (`@deepseek-ai/dsh-api-workspace-controller`), which is a
 * connection, never a DSH session.
 *
 * What does work is the registration itself. `ctx.slots` is one service instance
 * for every plugin in the page, so a plugin can install its own `register` on it
 * and see every registration that passes through afterwards. The shipped
 * workspace plugin registers its seats through `ctx.slots.inject(name, factory)`
 * — a deferred registration, which is why it works whatever order the rows
 * activate in — so the hero-picker registration arrives here, and this package
 * hands the shipped component back with a filtered `useWorkspaces`: the same
 * options, the same children table, the same inject face and locale, and one
 * component that answers for the composer it is rendered in. Every other
 * registration the shipped plugin makes passes through untouched, and the shipped
 * row stays enabled, so nothing of DSH's workspace client is disabled, duplicated
 * or re-applied.
 *
 * That makes this repository responsible for the shape of the registration it
 * intercepts, which is why it is pinned by a test: `proofs/18-picker-pin.ts`
 * reads the shipped bundle and fails when the registration, the pick flow's state
 * selection, the shipped service list or the pinned DSH version moves.
 *
 * ## What the filter is, and the one thing it cannot know
 *
 * Which workspaces are arbor's is decided by path: an arbor project's path
 * carries the `arbor/shared` segments (`DSH_HOME/arbor/shared/<project>`), and a
 * workspace outside them is external. DSH offers a `dsh.client` package no
 * channel to read the host's shared folder — `harness.handle`/`invoke` is the
 * dynamic-plugin sandbox API and `settings/describe` is credentials only — so the
 * rule is a path convention rather than a host answer. It is documented as a
 * known limitation in `docs/b3b-projects-and-sandbox.md` and pinned by the same
 * test.
 *
 * ## The pick the workspace switch drops, put back
 *
 * The same wrapper carries the composer's preset across a workspace switch.
 * DSH's `reuseLive` (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`)
 * re-selects the resolved deployment default on the blank session a workspace
 * switch reuses, because the picker's own adopt path
 * (`createInWorkspace` → `createNamed`) names no preset: an Arbor pick made a
 * moment earlier is followed back off arbor by the driver's reverse re-route,
 * which leaves a session labelled Arbor running the embedded loop until the
 * pick is re-committed. So the wrapped `onPick` re-commits it, through the same
 * hero seat the user clicked, once the session the switch opened is there to
 * take it: the seat's own `select` stages the pick and its `apply` hands it to
 * the session the main view shows
 * (`@deepseek-ai/dsh-client-ui-agent-preset`, `lib/client.js`), which is the
 * same remote call the chip itself makes — no verb of this package's own.
 *
 * The log cannot tell the two selections apart: `presets.select` is the single
 * writer of `agent-preset/selected`
 * (`@deepseek-ai/dsh-agent-preset-registry`, `lib/index.js`), so a
 * controller-issued re-select and a user's pick append the same event. That is
 * why the fix is here, in the surface that knows what the user clicked, rather
 * than in the driver second-guessing an event it cannot attribute.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore, type ComponentType } from 'react'

/** The composer seat the shipped ui-workspace plugin occupies. */
const PICKER_SLOT = 'conversation.hero.workspace'

/** The hero seat DSH's agent-preset package occupies, which stages the pick. */
const HERO_SEAT_SLOT = 'conversation.hero.agentPreset'

/** The agent-preset id whose sessions run arbor. */
const ARBOR_PRESET = 'arbor'

/** The projection key the composer's own preset selector reads. */
const PRESET_PROJECTION = 'agentPreset'

/** How often to look for the hero seat before giving up. */
const POLL_MS = 40

/** Give up looking for the hero seat after this many polls (~20s). */
const MAX_POLLS = 500

/** How long a workspace switch is given to open the session it opens. */
const CARRY_MS = 2_000

/**
 * The session the main view is showing, which is the session a composer belongs
 * to. The hero seats are rendered without a session id — the conversation's own
 * hero row passes only `open`, `anchorRef`, `selectedId`, `onPick` and `onClose`
 * — so the session is read from the sessions store the same way DSH's own
 * agent-preset plugin reads it: the row the main view retains
 * (`@deepseek-ai/dsh-client-ui-agent-preset`, `mainBlank`).
 */
function useMainSessionId(props: Record<string, unknown>): string | undefined {
  const useSessions = props['useSessions'] as SessionsHook | undefined
  return useSessions?.((state: SessionsState) => {
    for (const [id, row] of Object.entries(state.byId)) {
      if ((row.retainedBy?.mainView ?? 0) > 0) return id
    }
    return undefined
  }) as string | undefined
}

/**
 * The composer's own preset projection, read the way the composer's preset
 * selector reads it: `useProjection(key)` answers the session's committed value
 * for that key. A deployment with no agent-preset surface has no such prop, and
 * the gate then answers from the hero seat alone.
 */
function useProjectionOf(props: Record<string, unknown>): unknown {
  const useProjection = props['useProjection'] as ((key: string) => unknown) | undefined
  return useProjection?.(PRESET_PROJECTION)
}

/**
 * The services this plugin needs. `slots` is the seat the filter intercepts;
 * `remoteAccess` and `remote` are what the shipped plugin's own registrations
 * read while they pass through this plugin's fiber, and the rest are the ones its
 * `apply` declares, because a registration it makes here is disposed with this
 * plugin. `proofs/18-picker-pin.ts` asserts the list still matches the shipped
 * plugin's own.
 */
export const inject: readonly string[] = [
  'contextMenus',
  'slots',
  'sessions',
  'workspaces',
  'locale',
  'remote',
  'remote.directoryPicker',
  'layout',
  'shortcuts',
  'remoteAccess',
]

/** One workspace row, as far as this package reads it. */
interface WorkspaceRow {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

/** The workspace store's state: the rows and the phase around them. */
interface WorkspaceState {
  readonly items: readonly WorkspaceRow[]
  readonly [key: string]: unknown
}

/** One `useWorkspaces` selector hook, the way the shipped components call it. */
type WorkspaceHook = (selector: (state: WorkspaceState) => unknown) => unknown

/** One session row of the client sessions store, as far as this package reads it. */
interface SessionRow {
  readonly retainedBy?: { readonly mainView?: number }
}

/** The client sessions store: one row per session, keyed by id. */
interface SessionsState {
  readonly byId: Readonly<Record<string, SessionRow>>
}

/** One `useSessions` selector hook, the way the shipped components call it. */
type SessionsHook = (selector: (state: SessionsState) => unknown) => unknown

/** Any selector hook the slot runtime hands a component, by its prop name. */
type SelectorHook = (selector: (state: never) => unknown) => unknown

/**
 * The slice of the client slots service this package uses. `ctx.slots` is added
 * to the cordis Context by `@deepseek-ai/dsh-client-ui-slots`' module
 * augmentation, a type-only package this bridge neither depends on nor imports,
 * so the few members used here are declared locally rather than imported.
 */
interface SlotsService {
  entriesOfSlot?(name: string): readonly { inject?: unknown }[]
  register(
    options: { name: string; [key: string]: unknown },
    component: (props: never) => unknown,
  ): () => void
}

/**
 * The slice of DSH's own workspace service this package uses: the same call the
 * shipped plugin makes when a session row is opened
 * (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`, `openSession`), which
 * re-retains the session for the main view and re-publishes the main binding.
 * That is the public path that re-resolves the hero's session scope after the
 * driver has replaced the agent under it.
 */
/** One session row of the client sessions store, as far as this package reads it. */
interface SessionSummary {
  readonly id: string
  readonly blank?: boolean
  readonly cwd?: string
  readonly projectionValues?: { readonly agentPreset?: unknown }
  readonly retainedBy?: { readonly mainView?: number }
}

/** The client sessions store: the rows and the retention facts beside them. */
interface SessionsStore {
  list: {
    getSnapshot(): { byId: Readonly<Record<string, SessionSummary>> }
    subscribe(listener: () => void): () => void
  }
  retainInfo(sessionId: string): {
    getSnapshot(): { retainedBy?: { mainView?: number } }
  }
}

/** The staged pick DSH's hero chip keeps for the session about to start. */
interface AgentPresetSeatSnapshot {
  /** The staged choice, empty until the roster loads. */
  readonly current: string
}

/** One seat store, as far as this package reads it. */
interface AgentPresetSeatStore {
  getSnapshot(): AgentPresetSeatSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * The hero seat's registration-side face (`AgentPresetSeatInjected`), the part
 * this package reads. Declared locally because
 * `@deepseek-ai/dsh-client-ui-agent-preset` is a browser package this bridge
 * neither depends on nor imports: the face is reached through the slot entry's
 * own `inject`, exactly as the slot runtime reaches it.
 */
interface AgentPresetSeatInjected {
  readonly hooks: {
    readonly agentPresetSeat: AgentPresetSeatStore
  }
  /**
   * The seat's own commit, which is the hero chip's: stage the pick and hand it
   * to the session the main view shows
   * (`@deepseek-ai/dsh-client-ui-agent-preset`, `lib/client.js`: the face's
   * `select` → `AgentPresetSeatController.select` → `apply` →
   * `ctx.remote.agentPresets.select`). Reading it is how this package re-commits
   * a pick the workspace switch dropped, without a verb of its own.
   */
  readonly select?: (id: string) => unknown
}

/** The hero seat's `inject`, called the way the slot runtime calls it. */
type AgentPresetSeatInject = (sessionId?: string) => AgentPresetSeatInjected

/**
 * Whether a workspace path is one of arbor's shared-folder projects.
 *
 * An arbor project is a subfolder of the shared folder, `DSH_HOME/arbor/shared`,
 * so its path carries those two segments in a row. The rule is a path
 * convention because a client package has no channel to the host's own answer
 * (see the module comment); it is pinned by the proof beside it.
 */
function isArborProject(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(segment => segment !== '')
  for (let index = 0; index + 1 < segments.length; index++) {
    if (segments[index] === 'arbor' && segments[index + 1] === 'shared') return true
  }
  return false
}

/** The marker an external workspace's row carries in an arbor composer. */
const EXTERNAL_MARK = '（外部）'

/**
 * The rows one composer lists: an arbor composer lists everything and marks the
 * directories outside the shared folder as external; any other composer lists
 * nothing from arbor's tree, because an ordinary session's tools are sandboxed
 * and its cwd would write into ovnfs's source.
 */
function filterRows(rows: readonly WorkspaceRow[], preset: string | undefined): readonly WorkspaceRow[] {
  if (preset === ARBOR_PRESET) {
    return rows.map(row => (isArborProject(row.path) ? row : { ...row, title: `${row.title}${EXTERNAL_MARK}` }))
  }
  return rows.filter(row => !isArborProject(row.path))
}

/**
 * The state a filtered `useWorkspaces` hands the shipped components.
 *
 * Memoized on the store's own state and the preset, because a selector hook's
 * snapshot has to be referentially stable: the shipped pick flow reads the whole
 * state (`useWorkspaces((state) => state)`) and `useSyncExternalStore` would
 * re-render forever on a fresh object per call. Everything the state carries
 * besides the rows is passed through untouched, so a store field this package
 * does not know about reaches the shipped component exactly as it stands.
 */
let cached: { state: WorkspaceState; preset: string | undefined; result: WorkspaceState } | undefined
function filterState(state: WorkspaceState, preset: string | undefined): WorkspaceState {
  if (cached !== undefined && cached.state === state && cached.preset === preset) return cached.result
  const result: WorkspaceState = { ...state, items: filterRows(state.items, preset) }
  cached = { state, preset, result }
  return result
}

/**
 * Intercept the workspace client's registrations and filter the hero picker.
 * @param ctx - the client root context.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotsService }).slots
  // The staged pick, read exactly as `@4fu/dsh-arbor-ui`'s sandbox gate reads
  // it: the hero chip writes its pick into the seat's own store before the Host
  // commits it, so the seat store decides for a composer whose session has not
  // committed a preset yet and the projection decides for one that has.
  let heroInject: AgentPresetSeatInject | undefined
  let unboundSeat: AgentPresetSeatStore | undefined

  /**
   * The seat store the hero chip uses for one session: the seat bound to that
   * session when there is one, the unbound seat otherwise. Only the unbound seat
   * is memoized — a bound seat is looked up per render, because whether a session
   * has a binding yet is not something this package can see, and a cached answer
   * would go stale the moment one appears.
   */
  const heroSeatFor = (sessionId: string | undefined): AgentPresetSeatStore | undefined => {
    if (heroInject === undefined) return undefined
    if (sessionId === undefined) {
      unboundSeat ??= heroInject()?.hooks?.agentPresetSeat
      return unboundSeat
    }
    return heroInject(sessionId)?.hooks?.agentPresetSeat
  }

  // The hero seat is registered by the agent-preset plugin through its own
  // deferred `inject`, on a timeline this package does not observe, so its face
  // is read by polling `entriesOfSlot` until it appears. The poll is cheap,
  // bounded, and stops on success, on dispose, and when the deployment has no
  // agent-preset surface at all — in which case the gate falls back to the
  // projection, which is what a session that already runs a preset answers with.
  let poll: ReturnType<typeof setInterval> | undefined
  let attempts = 0
  const stop = (): void => {
    if (poll !== undefined) { clearInterval(poll); poll = undefined }
  }
  const look = (): void => {
    if (heroInject !== undefined) { stop(); return }
    if (++attempts > MAX_POLLS) { stop(); return }
    const face = slots.entriesOfSlot?.(HERO_SEAT_SLOT)[0]?.inject
    if (typeof face === 'function') {
      heroInject = face as AgentPresetSeatInject
      stop()
    }
  }
  ctx.effect(() => () => { stop() }, 'dsh-arbor-ui-workspace: stop the hero-seat poll')
  poll = setInterval(look, POLL_MS)
  look()

  /**
   * The pick the composer is about to run with. The seat the hero chip writes to
   * is the one bound to the session the main view shows, and the unbound seat is
   * what a composer with no session yet reads; both are read, because the chip is
   * bound while a blank session is current and unbound before one exists. Either
   * store naming arbor is the answer, and the unbound store answers the
   * Host-effective default when nothing is staged, so it never invents an arbor
   * session. The projection is the last resort, for a deployment with no hero
   * seat.
   */
  function usePresetPick(sessionId: string | undefined, projected: unknown): string | undefined {
    const bound = heroSeatFor(sessionId)
    const unbound = heroSeatFor(undefined)
    return useSyncExternalStore(
      (onChange: () => void) => {
        const stops = [bound, unbound].map(store => store?.subscribe(onChange))
        return () => { for (const halt of stops) halt?.() }
      },
      () => {
        const picks = [bound, unbound].map(store => store?.getSnapshot().current)
        return picks.find(pick => pick === ARBOR_PRESET)
          ?? picks.find(pick => pick !== undefined && pick !== '')
          ?? (typeof projected === 'string' ? projected : undefined)
      },
    )
  }

  const sessions = (ctx as unknown as { sessions: SessionsStore }).sessions

  /** The hero seat's registration-side face for one session, when it is there. */
  const heroFace = (sessionId: string): AgentPresetSeatInjected | undefined => (
    heroInject === undefined ? undefined : heroInject(sessionId)
  )

  /**
   * The session the main view retains, which is the session a composer belongs
   * to. Read from the store rather than from a component's props, because the
   * follow-up below runs from an event handler, not from a render.
   */
  const mainSession = (): SessionSummary | undefined => {
    const byId = sessions?.list.getSnapshot().byId ?? {}
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return byId[id]
    }
    return undefined
  }

  /**
   * The shipped component with a filtered `useWorkspaces`: the pick flow's own
   * selector calls are forwarded to the shipped hook, and the state they read is
   * this composer's filtered view. Every other prop passes through untouched, so
   * the picker is the shipped one in every other respect.
   *
   * `onPick` is wrapped as well, and that wrapper carries the composer's preset
   * across a workspace switch. DSH's own `reuseLive`
   * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) re-selects the
   * resolved deployment default on the blank session a workspace switch reuses,
   * because the picker's adopt path (`createInWorkspace` →
   * `createNamed`) names no preset — so an Arbor pick made a moment earlier is
   * followed back off arbor by the driver's own reverse re-route. The pick is
   * re-committed here through the same hero seat the user clicked, which is the
   * seat's own `select` → `apply` → `ctx.remote.agentPresets.select` path.
   */
  const gate = (shipped: unknown) => (props: Record<string, unknown>): unknown => {
    const sessionId = useMainSessionId(props)
    const preset = usePresetPick(sessionId, useProjectionOf(props))
    const useWorkspaces = props['useWorkspaces'] as WorkspaceHook | undefined
    const filtered = (selector: (state: WorkspaceState) => unknown): unknown => (
      useWorkspaces === undefined
        ? undefined
        : selector(filterState(useWorkspaces(state => state) as WorkspaceState, preset))
    )
    const onPick = props['onPick'] as ((workspaceId: string) => unknown) | undefined
    const carryPick = onPick === undefined ? undefined : (workspaceId: string): unknown => {
      const outcome = onPick(workspaceId)
      // The switch is asynchronous and its promise is not handed back — the hero's
      // own `onPick` is a block-bodied arrow — so the session it opens is waited
      // for by watching the store. DSH's `reuseLive` re-selects the resolved
      // deployment default on that session, and the pick is re-committed here
      // once it is there to take it: the seat's own `select` stages the pick and
      // `apply` hands it to the session the main view then shows.
      if (preset === ARBOR_PRESET) {
        const before = sessionId
        const deadline = Date.now() + CARRY_MS
        const settle = (): void => {
          const main = mainSession()
          if (main === undefined || main.blank !== true) return
          if (main.id === before && Date.now() < deadline) {
            setTimeout(settle, POLL_MS)
            return
          }
          const committed = main.projectionValues?.agentPreset
          if (committed !== ARBOR_PRESET) heroFace(main.id)?.select?.(ARBOR_PRESET)
        }
        setTimeout(settle, POLL_MS)
      }
      return outcome
    }
    return createElement(shipped as ComponentType<Record<string, unknown>>, {
      ...props,
      useWorkspaces: filtered,
      ...carryPick === undefined ? {} : { onPick: carryPick },
    })
  }

  // The wrapper is an own property on the service instance, which is what makes
  // the shipped plugin's own `ctx.slots.register` calls go through it: the
  // instance is the one every plugin's `ctx.slots` resolves to, and the shipped
  // plugin registers its seats through `ctx.slots.inject`, whose deferred
  // callbacks run after the whole boot has applied — so the order the rows
  // activate in does not matter. It stays installed for as long as this plugin is
  // live, and is removed with it.
  const original = slots.register.bind(slots)
  const register = (
    options: { name: string; [key: string]: unknown },
    component: (props: never) => unknown,
  ): (() => void) => (
    options.name === PICKER_SLOT
      ? original(options, gate(component) as (props: never) => unknown)
      : original(options, component)
  )
  Object.defineProperty(slots, 'register', { value: register, configurable: true, writable: true })
  ctx.effect(() => () => {
    delete (slots as unknown as { register?: unknown }).register
  }, 'dsh-arbor-ui-workspace: restore slots.register')
}
