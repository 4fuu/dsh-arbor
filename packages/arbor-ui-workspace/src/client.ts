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
 * ## The pick the workspace switch drops, put back at create
 *
 * The same wrapper carries the composer's preset across a workspace switch, and
 * it does it where DSH's own create can take it. DSH's picker adopt path names
 * no preset — the hero's `onPick` is `selectWorkspace(workspaceId)` →
 * `workspaceNavigation.openWorkspace(workspaceId, beforeOpen)`
 * (`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`) with no options
 * bag — and `openWorkspace` → `connectBlank` → `createInWorkspace` forwards
 * `options.agentPreset` to `sessions.create` when it is given
 * (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`: `createInWorkspace`
 * spreads `...options.agentPreset === void 0 ? {} : { agentPreset }`). So the
 * only missing piece is the option itself.
 *
 * It is supplied by wrapping `uiWorkspace.openWorkspace` on the service
 * instance — one method, filled in only when the caller gave none and the
 * composer's pick is Arbor. Everything else about the shipped path is
 * untouched: the same blank reuse rules, the same draft carry in `beforeOpen`,
 * the same `startSession` calls that already name a preset. A session created
 * that way carries `agentPreset` in its creation `meta`
 * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`, `createAgent`),
 * which is what `ArborAgentRegistry.create` routes on — so the pick is
 * creation-time routing, not a re-select, and no `agent-preset/selected` event
 * is written for it.
 *
 * **Where the create cannot take it: a row this package cannot read.** The wrap
 * fills the option only when the workspace row is in the client's own list, so
 * the path is known to be one an arbor session may work in. `DshProjectBridge.
 * resolveProject` answers the requested directory as-is
 * (`packages/arbor-workspace/src/projects.ts`), so a project of the shared
 * folder and a directory the user added outside it both work: the session ends
 * up a member of the workspace the user picked, which is what the sidebar shows.
 * A row the client has not listed yet falls through to the shipped adopt and the
 * pick is asked for again afterwards ({@link reaskPick}).
 *
 * The earlier fix re-committed the pick through the hero seat after the switch,
 * which is what made DSH's own `reuseLive`
 * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) follow it back off
 * arbor and the driver re-route the session under a live binding. That path is
 * gone for the shared folder's projects: create carries the pick, so there is
 * nothing to follow back. The log cannot tell a controller-issued selection
 * from a user's pick anyway (`presets.select` is the single writer of
 * `agent-preset/selected`, `@deepseek-ai/dsh-agent-preset-registry`,
 * `lib/index.js`), which is why the fix belongs here, in the surface that knows
 * what the user clicked.
 *
 * ## The sidebar browser: marked, not filtered
 *
 * The same registration wrapper reaches the sidebar browser
 * (`sidebar.workspaces`), which the shipped plugin registers through the same
 * deferred `ctx.slots.inject` (`@deepseek-ai/dsh-client-ui-workspace`,
 * `lib/client.js`). The sidebar lists every workspace for every session, so
 * there is no composer preset to key a filter on — filtering there would hide
 * arbor's projects from a user who is working in one, which is the same lie in
 * the other direction. So arbor's rows are marked `（Arbor）` instead: an
 * ordinary user can see which rows an ordinary session cannot use, and a user in
 * an arbor session still sees them.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore, type ComponentType } from 'react'

/** The composer seat the shipped ui-workspace plugin occupies. */
const PICKER_SLOT = 'conversation.hero.workspace'

/** The hero seat DSH's agent-preset package occupies, which stages the pick. */
const HERO_SEAT_SLOT = 'conversation.hero.agentPreset'

/**
 * The sidebar's workspace browser seat. The shipped workspace plugin registers
 * it through the same deferred `ctx.slots.inject` the hero picker uses
 * (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`:
 * `ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({...},
 * WorkspaceBrowser))`), so the registration wrapper reaches it too.
 */
const SIDEBAR_SLOT = 'sidebar.workspaces'

/** The agent-preset id whose sessions run arbor. */
const ARBOR_PRESET = 'arbor'

/** The projection key the composer's own preset selector reads. */
const PRESET_PROJECTION = 'agentPreset'

/**
 * The marker an arbor row carries in the sidebar, where there is no composer
 * preset to key on: the sidebar lists every workspace, so hiding arbor's rows
 * there would hide them from a user who is in an arbor session too. The mark
 * says which rows are arbor's own, so an ordinary user can tell what an
 * ordinary session cannot use.
 */
const ARBOR_MARK = '（Arbor）'

/** How often to look for the hero seat before giving up. */
const POLL_MS = 40

/** Give up looking for the hero seat after this many polls (~20s). */
const MAX_POLLS = 500

/** The workspace service's own adopt call, the one the hero picker reaches. */
const NAVIGATION_SERVICE = 'uiWorkspace'

/** How long an adopt is given to open the session the pick is re-committed on. */
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
   * `ctx.remote.agentPresets.select`). It is how this package re-commits a pick
   * the adopt path could not carry, with no verb of its own.
   */
  readonly select?: (id: string) => unknown
}

/** The hero seat's `inject`, called the way the slot runtime calls it. */
type AgentPresetSeatInject = (sessionId?: string) => AgentPresetSeatInjected

/**
 * The slice of DSH's own workspace service this package wraps: the adopt call
 * the hero picker reaches with no options bag
 * (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`, `openWorkspace`).
 */
interface WorkspaceAdopt {
  openWorkspace(
    workspaceId: string,
    beforeOpen?: (sessionId: string) => void,
    options?: { agentPreset?: string },
  ): void
}

/** The slice of the client workspaces service this package reads a row from. */
interface WorkspacesService {
  list: {
    getSnapshot(): { items: readonly WorkspaceRow[] }
  }
}

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

/** Memoized on the store's own state, for the same reason {@link filterState} is. */
let markedCache: { state: WorkspaceState; result: WorkspaceState } | undefined
function markState(state: WorkspaceState): WorkspaceState {
  if (markedCache !== undefined && markedCache.state === state) return markedCache.result
  const result: WorkspaceState = {
    ...state,
    items: state.items.map(row => (isArborProject(row.path)
      ? { ...row, title: `${row.title}${ARBOR_MARK}` }
      : row)),
  }
  markedCache = { state, result }
  return result
}

/**
 * Intercept the workspace client's registrations: filter the hero picker per
 * preset, and mark arbor's rows in the sidebar browser.
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
  // deferred `inject`, and the workspace service is registered by the shipped
  // workspace plugin's own `apply`; neither fires on a timeline this package can
  // subscribe to, so both are waited for by polling. The poll is cheap, bounded,
  // and stops on success, on dispose, and when the deployment has no such
  // surface at all — in which case the gate falls back to the projection, which
  // is what a session that already runs a preset answers with.
  let poll: ReturnType<typeof setInterval> | undefined
  let attempts = 0
  let adoptWrapped = false
  const stop = (): void => {
    if (poll !== undefined) { clearInterval(poll); poll = undefined }
  }
  const look = (): void => {
    if (++attempts > MAX_POLLS) { stop(); return }
    if (heroInject === undefined) {
      const face = slots.entriesOfSlot?.(HERO_SEAT_SLOT)[0]?.inject
      if (typeof face === 'function') heroInject = face as AgentPresetSeatInject
    }
    if (!adoptWrapped) {
      const navigation = (ctx as unknown as { get(name: string): unknown }).get(NAVIGATION_SERVICE)
      if (navigation !== undefined) { wrapAdopt(); adoptWrapped = true }
    }
    if (heroInject !== undefined && adoptWrapped) stop()
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

  /**
   * The session the main view retains, which is the session a composer belongs
   * to. Read from the store rather than from a component's props, because the
   * wrap below is installed from a poll, not from a render.
   */
  const mainSession = (): SessionSummary | undefined => {
    const byId = sessions?.list.getSnapshot().byId ?? {}
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return byId[id]
    }
    return undefined
  }

  /** The composer's own pick, read the way the picker's filter reads it. */
  const currentPick = (): string | undefined => {
    const bound = heroSeatFor(mainSession()?.id)
    const unbound = heroSeatFor(undefined)
    const picks = [bound, unbound].map(store => store?.getSnapshot().current)
    return picks[0] !== undefined && picks[0] !== ''
      ? picks[0]
      : picks.find(pick => pick !== undefined && pick !== '')
  }

  /**
   * The hero seat's face as it stands now, which is the one to ask for a pick.
   *
   * It is read fresh rather than taken from the cached `heroInject`, because the
   * occupant of that seat changes after boot: `@4fu/dsh-arbor-ui` shadows it one
   * priority below the shipped occupant, and `entriesOfSlot` reports the
   * lowest-priority one — the shadow, once it is registered. Asking the shadow
   * for the pick is what makes the pick a *create* (it mints a session under the
   * preset); asking the shipped face would commit it on the live session, which
   * is the re-route this package exists to avoid. Where arbor-ui is not loaded
   * the shipped face answers, and the pick is committed the way it always was.
   */
  const heroFaceNow = (sessionId: string | undefined): AgentPresetSeatInjected | undefined => {
    const face = slots.entriesOfSlot?.(HERO_SEAT_SLOT)[0]?.inject
    return typeof face === 'function' ? (face as AgentPresetSeatInject)(sessionId) : undefined
  }

  /** The workspace row one id names, when the registry lists it. */
  const workspaceRow = (workspaceId: string): WorkspaceRow | undefined => {
    const items = (ctx as unknown as { get(name: string): unknown })
      .get('workspaces') as WorkspacesService | undefined
    return items?.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
  }

  /**
   * Ask the hero seat for the composer's Arbor pick again, once the session an
   * adopt opened is there to take it.
   *
   * This is the path for a workspace whose row this package cannot read — the
   * adopt runs as it stands and the pick is committed on the session it opened.
   * A workspace whose row IS readable is handled at create instead
   * ({@link wrapAdopt}), so this path is the fallback for an unknown row and not
   * the main one.
   */
  const reaskPick = (before: string | undefined): void => {
    const deadline = Date.now() + CARRY_MS
    const settle = (): void => {
      const main = mainSession()
      if (main === undefined || main.blank !== true) return
      if (main.id === before && Date.now() < deadline) {
        setTimeout(settle, POLL_MS)
        return
      }
      if (main.projectionValues?.agentPreset !== ARBOR_PRESET) {
        heroFaceNow(main.id)?.select?.(ARBOR_PRESET)
      }
    }
    setTimeout(settle, POLL_MS)
  }

  /**
   * Supply the composer's Arbor pick to the adopt call that has none.
   *
   * The hero picker reaches `uiWorkspace.openWorkspace(workspaceId, beforeOpen)`
   * with no options bag, while every other caller of that method names its own
   * options — `startSession` always passes an object, preset or empty — so the
   * wrap fills the option only where it is missing, and only when the pick is
   * Arbor: an ordinary composer's switch is byte-for-byte the shipped call.
   *
   * It fills it for every workspace whose row this package can read, because
   * `DshProjectBridge.resolveProject` answers the requested directory as-is: an
   * arbor session created in a project of the shared folder works in that
   * project, and one created in a directory the user added outside it works in
   * that directory and names it as an external pointer. So the pick rides the
   * same create in both cases, and the session ends up a member of the workspace
   * the user picked — which is what puts it in the sidebar under that row.
   *
   * The method is wrapped on the service instance rather than replaced, and the
   * original is restored with this plugin.
   */
  const wrapAdopt = (): void => {
    const navigation = (ctx as unknown as { get(name: string): unknown })
      .get(NAVIGATION_SERVICE) as WorkspaceAdopt | undefined
    if (navigation === undefined || typeof navigation.openWorkspace !== 'function') return
    if ((navigation as { __arborAdopt?: boolean }).__arborAdopt === true) return
    const original = navigation.openWorkspace.bind(navigation)
    navigation.openWorkspace = (
      workspaceId: string,
      beforeOpen?: (sessionId: string) => void,
      options?: { agentPreset?: string },
    ): void => {
      const pick = currentPick()
      const row = workspaceRow(workspaceId)
      const createTakesIt = pick === ARBOR_PRESET && row !== undefined
      const before = mainSession()?.id
      const outcome = original(workspaceId, beforeOpen, createTakesIt ? { agentPreset: pick } : options)
      if (pick === ARBOR_PRESET && !createTakesIt) reaskPick(before)
      return outcome
    }
    Object.defineProperty(navigation, '__arborAdopt', { value: true, configurable: true })
    ctx.effect(() => () => {
      navigation.openWorkspace = original
      delete (navigation as { __arborAdopt?: boolean }).__arborAdopt
    }, 'dsh-arbor-ui-workspace: restore uiWorkspace.openWorkspace')
  }

  /**
   * The shipped component with a filtered `useWorkspaces`: the pick flow's own
   * selector calls are forwarded to the shipped hook, and the state they read is
   * this composer's filtered view. Every other prop passes through untouched, so
   * the picker is the shipped one in every other respect. The pick itself rides
   * along at create through the wrapped adopt call above, not through a
   * re-commit after the switch.
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
    return createElement(shipped as ComponentType<Record<string, unknown>>, {
      ...props,
      useWorkspaces: filtered,
    })
  }

  /**
   * The sidebar browser with arbor's rows marked rather than filtered.
   *
   * The sidebar lists every workspace for every session, so there is no composer
   * preset to key a filter on — filtering there would hide arbor's projects from
   * a user who is working in one. The mark is the honest answer instead: it says
   * which rows are arbor's own, so an ordinary user can see that an ordinary
   * session cannot work in them.
   *
   * The component is the shipped one and every other prop passes through, so
   * only the rows' titles carry the mark — the same shape the hero picker's
   * external marker uses.
   */
  const marked = (shipped: unknown) => (props: Record<string, unknown>): unknown => {
    const useWorkspaces = props['useWorkspaces'] as WorkspaceHook | undefined
    const marking = (selector: (state: WorkspaceState) => unknown): unknown => (
      useWorkspaces === undefined
        ? undefined
        : selector(markState(useWorkspaces(state => state) as WorkspaceState))
    )
    return createElement(shipped as ComponentType<Record<string, unknown>>, {
      ...props,
      useWorkspaces: marking,
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
  ): (() => void) => {
    if (options.name === PICKER_SLOT) {
      return original(options, gate(component) as (props: never) => unknown)
    }
    if (options.name === SIDEBAR_SLOT) {
      return original(options, marked(component) as (props: never) => unknown)
    }
    return original(options, component)
  }
  Object.defineProperty(slots, 'register', { value: register, configurable: true, writable: true })
  ctx.effect(() => () => {
    delete (slots as unknown as { register?: unknown }).register
  }, 'dsh-arbor-ui-workspace: restore slots.register')
}
