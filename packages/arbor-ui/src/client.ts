/**
 * The dsh-arbor browser package (the seed B4 grows).
 *
 * Arbor's decision reverses part of B3: for arbor sessions DSH's sandbox goes
 * away and arbor's tools run on the host, so DSH's sandbox "Access mode"
 * control — the composer chip that reads "Workspace Write" and switches the
 * sandbox mode plus the approval policy bundled into a preset — is untrue on a
 * session that has no sandbox. Principle 8 (maximal glue, arbor wins) says
 * nothing untrue is left showing, so this package takes that control away for
 * arbor sessions and leaves it byte-for-byte in place for ordinary ones.
 *
 * The seam it uses is DSH's own, not a patch:
 *
 *  - `conversation.input.permission` is a `single` composer slot
 *    (`@deepseek-ai/dsh-client-ui-conversation`) occupied by
 *    `@deepseek-ai/dsh-client-ui-permission-presets`' `PermissionSelect`. A
 *    `single` slot renders its lowest-priority occupant, so a registration at a
 *    lower priority shadows the shipped one; the shipped occupant and its
 *    registration (`component`, `inject`, `locale`) are readable through
 *    `ctx.slots.entriesOfSlot`, which reports each entry's own fields at the
 *    top level rather than under an `options` bag.
 *  - The session's picked preset is a per-session projection,
 *    `useProjection("agentPreset")`, whose value is the preset id — `"arbor"`
 *    for an arbor session, the embedded loop's id otherwise.
 *
 * So this package registers its own occupant of that seat one priority below
 * the shipped one, reusing the shipped component, inject face and locale: the
 * real `PermissionSelect` for an ordinary session, and nothing for an arbor
 * one. Reusing the inject face and locale is what makes the ordinary path
 * byte-for-byte: without them the occupant has no `t` and no
 * `usePermissionCatalog`, so it throws on its first render, the slot's
 * supervision abdicates it, and the shipped occupant silently takes over —
 * which is how this package came to render nothing at all before. The shipped
 * occupant registers through permission-presets' own deferred `inject`, on a
 * timeline this package does not observe through a slot subscription, so the
 * shipped occupant is read by polling `entriesOfSlot` until it appears and then
 * captured; the poll stops the moment the gate is registered.
 * permission-presets stays enabled, so its `/permission` popup and
 * General-settings row are untouched for both.
 *
 * ## Why the projection alone is not enough
 *
 * A new session's preset is *staged* before it exists: the hero chip
 * (`conversation.hero.agentPreset`, `@deepseek-ai/dsh-client-ui-agent-preset`)
 * calls `AgentPresetSeatController.select()`, which writes the pick into that
 * controller's own `SnapshotStore` and only then hands it to the current
 * session — and a session that is still blank is exactly the one the composer
 * belongs to. Until the Host commits the pick, the session's `agentPreset`
 * projection still reads the previous value, so a gate that read only the
 * projection left "Workspace Write" showing on a composer the user had just
 * switched to Arbor. The chip's store is the authoritative staged pick, so the
 * gate reads it through the hero seat's own `inject` face
 * (`AgentPresetSeatInjected.hooks.agentPresetSeat`) and falls back to the
 * projection — which is what a session that already runs arbor answers with,
 * and what a deployment with no agent-preset surface has to offer.
 *
 * ## The pick that changes driver is a new session, not a re-route
 *
 * Picking Arbor in the hero used to be committed on the blank session the
 * composer already belongs to, and the driver then had to swap the agent under
 * it. That swap cannot be done without a lie: DSH binds the composer to one
 * agent object per session, and the only public release — `AgentHandle.dispose()`
 * — also removes the Session, so a re-route leaves the hero's `uiSession`
 * binding pointing at an agent that is gone (option (a) of one stable routing
 * handle is closed: `AgentRegistry.enter` refuses a second entry for one id, and
 * AgentLoop's `createAgent`/`resume` always call `sessions.prepare(id, …)`,
 * which throws for an existing id; see `docs/b3b-projects-and-sandbox.md`).
 *
 * So this package intercepts the pick instead, at the same seat the user
 * clicked: it shadows `conversation.hero.agentPreset` one priority below the
 * shipped occupant, carrying the shipped component, locale and inject face and
 * wrapping only the face's `select`. When the main session is a blank with no
 * turn and the pick crosses the arbor boundary, the wrapper does not commit on
 * that blank at all: it creates a new session under the picked preset through
 * the client's own `sessions.create` (`@deepseek-ai/dsh-cordis-client-runner`,
 * `lib/client.js`, `ISessions`), which is the `session/create` remote verb, and
 * with no `sessionId` the host mints one — `createSession(request)` →
 * `createMinted(request.cwd, await this.composeAgent(request.agentPreset))`
 * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) — so the
 * composition's `agentPreset` lands in the session's creation `meta`, which is
 * exactly what `ArborAgentRegistry.create` routes on. The session is therefore
 * *created* under the driver it will run: no swap, no `agent-preset/selected`
 * event, no window where the label and the driver disagree.
 *
 * The mint is opened through `uiWorkspace.openSession`, which changes the
 * hero's session id and so re-resolves its session scope — the public path that
 * works, where re-resolving the same id does not. The blank it replaces is
 * archived with the same call the session row's own archive action makes, and
 * the composer's draft (text and attachments) is carried across with the same
 * `conversation.input` shell API DSH's own workspace-switch carry uses, so a
 * user who typed before switching preset loses nothing.
 *
 * Both directions are minted, so Arbor back to Standard is a fresh embedded
 * session too. A pick that does not cross the boundary, and a pick on a session
 * that has already started a turn, are handed straight to the shipped `select`:
 * DSH's own seat then stages or drops it exactly as it does today. The driver's
 * own re-route stays as the fallback for the paths that never reach this seat —
 * an SDK or remote `agent-preset/select` on a blank — and it never fires on the
 * hero path, because that path writes no selection event at all.
 *
 * ## What this package does not do, and why
 *
 * The project-picker filter — arbor's shared-folder projects for an arbor
 * composer, nothing from arbor's tree for an ordinary one — is not here. The
 * picker seat (`conversation.hero.workspace`) declares a child slot
 * (`conversation.hero.workspace.directoryFlow`), and DSH's `SlotCore.register`
 * refuses a second declaration of a child key that is already declared
 * (`@deepseek-ai/dsh-web-frontend`, the frontend bundle's `SlotCore`), so an
 * occupant cannot be shadowed without re-declaring it; and an occupant
 * registered without the children table has no `renderSlot`, so the shipped
 * `WorkspacePicker` throws on its own directory flow and the slot's supervision
 * abdicates it. That filter lives in `@4fu/dsh-arbor-ui-workspace`, which wraps
 * the shipped registration instead; see `docs/b3b-projects-and-sandbox.md`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore, type ComponentType } from 'react'

/** The composer seat DSH's permission-presets package occupies. */
const SEAT_SLOT = 'conversation.input.permission'

/** The hero seat DSH's agent-preset package occupies. */
const HERO_SEAT_SLOT = 'conversation.hero.agentPreset'

/** The agent-preset id whose sessions have no DSH sandbox and hide the control. */
const ARBOR_PRESET = 'arbor'

/** The projection key the composer's own preset selector reads. */
const PRESET_PROJECTION = 'agentPreset'

/** How often to look for the shipped occupants before giving up. */
const POLL_MS = 40

/** Give up looking for the shipped occupants after this many polls (~20s). */
const MAX_POLLS = 500

/** How long a minted session is given to acquire the binding its draft needs. */
const CARRY_MS = 2_000

/** Required client services. */
export const inject: readonly string[] = ['slots']

/**
 * One `single`-slot occupant as `entriesOfSlot` reports it: the component, the
 * registration's own inject face and locale namespace, and the option bag
 * (which carries the slot's own `priority` when one was given).
 */
interface SeatEntry {
  readonly component: (props: never) => unknown
  readonly inject?: unknown
  readonly locale?: unknown
  readonly options?: { readonly priority?: number }
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
   * `ctx.remote.agentPresets.select`). Wrapping it is what lets this package
   * mint a session under the picked preset instead of re-routing a live blank.
   */
  readonly select?: (id: string) => unknown
}

/** The hero seat's `inject`, called the way the slot runtime calls it. */
type AgentPresetSeatInject = (sessionId?: string) => AgentPresetSeatInjected

/**
 * The slice of DSH's own sessions service this package uses. `create` is the
 * client half of the `session/create` remote verb
 * (`@deepseek-ai/dsh-cordis-client-runner`, `lib/client.js`, the `ISessions`
 * declaration), and it reaches
 * `ApiSessionController.createSession(request)` with no `sessionId`, which is
 * `createMinted(request.cwd, await this.composeAgent(request.agentPreset))`
 * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`) — so the
 * composition's `agentPreset` lands in the session's creation `meta`, which is
 * exactly what `ArborAgentRegistry.create` routes on. That is the whole point:
 * a session created under arbor needs no re-route at all.
 */
interface SessionsService {
  create(options: {
    workspaceId?: string
    cwd?: string
    agentPreset?: string
  }): Promise<string>
  /** The session's binding, which is what a composer shell needs to exist. */
  binding(sessionId: string): unknown
  list: {
    getSnapshot(): { byId: Readonly<Record<string, SessionSummary>> }
    subscribe(listener: () => void): () => void
  }
}

/** One session row of the client sessions store, as far as this package reads it. */
interface SessionSummary {
  readonly id: string
  readonly blank?: boolean
  readonly cwd?: string
  readonly projectionValues?: { readonly agentPreset?: unknown }
  readonly retainedBy?: { readonly mainView?: number }
}

/** One workspace row, as far as this package reads it. */
interface WorkspaceSummary {
  readonly workspaceId: string
  readonly sessionIds: readonly string[]
}

/** The slice of DSH's own workspace service this package reads. */
interface WorkspacesService {
  list: {
    getSnapshot(): { items: readonly WorkspaceSummary[] }
  }
}

/**
 * The slice of DSH's own workspace service this package drives: the same calls
 * the shipped plugin makes when a session row is opened or archived
 * (`@deepseek-ai/dsh-client-ui-workspace`, `lib/client.js`, `openSession` /
 * `archiveSession`).
 */
interface WorkspaceNavigation {
  openSession(sessionId: string): void
  archiveSession(sessionId: string): Promise<unknown>
}

/**
 * The slice of DSH's conversation service this package reads a draft through:
 * `conversation.input.shell(id)` is the same per-session input shell the
 * conversation plugin's own workspace-switch carry uses
 * (`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`: `inputHub.shell`,
 * `draftSnapshot`, `setDraft`, `addAttachments`).
 */
interface ConversationShell {
  readonly draftSnapshot?: { readonly text?: string }
  readonly snapshot?: { readonly attachmentIds?: readonly string[] }
  setDraft(draft: unknown): void
  addAttachments(ids: readonly string[]): boolean
}

/** The slice of the conversation service that owns the composer's input shells. */
interface ConversationService {
  readonly input: {
    shell(sessionId: string): ConversationShell
  }
}

/**
 * The slice of the client slots service this package uses. `ctx.slots` is added
 * to the cordis Context by the frontend bundle's slot runtime, a type-only
 * package this bridge neither depends on nor imports, so the few members used
 * here are declared locally rather than imported.
 */
interface SlotsService {
  entriesOfSlot(name: string): readonly SeatEntry[]
  register(
    options: {
      name: string
      priority?: number
      locale?: unknown
      inject?: unknown
    },
    component: (props: never) => unknown,
  ): () => void
}

/**
 * Shadow the composer access-mode seat with an arbor gate.
 * @param ctx - the client root context.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotsService }).slots
  // Read lazily rather than injected: `sessions`, `workspaces`, `uiWorkspace`
  // and `conversation` come from client packages this one does not declare, and
  // a deployment without them (a profile with no browser, or a reduced client
  // graph) must still get the sandbox gate. `Context.get` answers undefined for
  // a service that is not registered, which is exactly the fallback this
  // package wants.
  const service = <T>(name: string): T | undefined => (
    ctx as unknown as { get(name: string): unknown }
  ).get(name) as T | undefined
  let dispose: (() => void) | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let attempts = 0
  let heroDispose: (() => void) | undefined
  let heroAttempts = 0

  const stop = (): void => {
    if (poll !== undefined) { clearInterval(poll); poll = undefined }
  }

  // The hero chip's staged pick. Resolved from the hero seat's own registration
  // once DSH's agent-preset surface has mounted; absent leaves the gate on the
  // projection alone, which is what a deployment with no such surface answers.
  let heroInject: AgentPresetSeatInject | undefined
  let unboundSeat: AgentPresetSeatStore | undefined

  /**
   * The seat store the hero chip uses for one session: the seat bound to that
   * session when there is one, the unbound seat otherwise. Only the unbound
   * seat is memoized — a bound seat is looked up per render, because whether a
   * session has a binding yet is not something this package can see, and a
   * cached answer would go stale the moment one appears.
   */
  const heroSeatFor = (sessionId: string | undefined): AgentPresetSeatStore | undefined => {
    if (heroInject === undefined) return undefined
    if (sessionId === undefined) {
      unboundSeat ??= heroInject()?.hooks?.agentPresetSeat
      return unboundSeat
    }
    return heroInject(sessionId)?.hooks?.agentPresetSeat
  }

  // Register this package's occupant one priority below the shipped seat, reusing
  // the shipped component, inject face and locale so an ordinary session renders
  // the identical control and only an arbor session renders nothing.
  const gate = (seat: SeatEntry) => (props: never): unknown => {
    const runtime = props as { sessionId?: string; useProjection?: (key: string) => unknown }
    const main = useMainSession()
    const staged = usePresetPick(runtime.sessionId)
    const projected = runtime.useProjection?.(PRESET_PROJECTION)
    // A session that has started a turn keeps the driver it began with — DSH's
    // preset registry refuses a later selection — so on such a session the
    // chip's staged pick is inert and only the committed projection is true.
    // Reading the staged pick there would take the sandbox switch away from an
    // ordinary session, which is the same lie in the other direction.
    const stagedCounts = main === undefined || main.blank === true
    if (projected === ARBOR_PRESET) return null
    if (stagedCounts && staged === ARBOR_PRESET) return null
    return createElement(seat.component as unknown as ComponentType, props as Record<string, unknown>)
  }

  /**
   * Subscribe this render to the hero chip's staged pick for one session.
   *
   * The seat bound to the composer's session decides when it has an answer: it
   * is the store the chip writes its pick into for that session, and it is also
   * the one that reads the session's own committed preset once the Host has
   * one. The unbound seat — the chip before any session exists, and the last
   * pick staged for the next one — is the fallback, and it is consulted only
   * while the bound seat has not loaded: an unbound store that still names a
   * preset the bound session does not run would otherwise take the sandbox
   * switch away from an ordinary session, which is the same lie in the other
   * direction. The unbound store answers the Host-effective default when
   * nothing is staged, so it never invents an arbor session.
   */
  function usePresetPick(sessionId: string | undefined): string | undefined {
    const bound = heroSeatFor(sessionId)
    const unbound = heroSeatFor(undefined)
    return useSyncExternalStore(
      (onChange: () => void) => {
        const stops = [bound, unbound].map(one => one?.subscribe(onChange))
        return () => { for (const halt of stops) halt?.() }
      },
      () => {
        const picks = [bound, unbound].map(one => one?.getSnapshot().current)
        // The bound seat answers first; the unbound one only while it is empty,
        // which is the window between a session appearing and its roster read.
        return picks[0] !== undefined && picks[0] !== ''
          ? picks[0]
          : picks.find(pick => pick !== undefined && pick !== '')
      },
    )
  }

  /**
   * The session the main view retains, which is the session the hero chip and
   * the composer both belong to. Read from the store rather than from a
   * component's props, because the mint below runs from an event handler.
   */
  const mainSession = (): SessionSummary | undefined => {
    const byId = service<SessionsService>('sessions')?.list.getSnapshot().byId ?? {}
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return byId[id]
    }
    return undefined
  }

  /**
   * The main session, reactively: the composer's gate reads it, because whether
   * the staged pick is still the truth depends on whether that session has
   * started a turn.
   */
  function useMainSession(): SessionSummary | undefined {
    const sessions = service<SessionsService>('sessions')
    return useSyncExternalStore(
      (onChange: () => void) => sessions?.list.subscribe(onChange) ?? (() => undefined),
      () => mainSession(),
    )
  }

  /** The preset the session's log has committed, or undefined before one is. */
  const presetOf = (session: SessionSummary | undefined): string | undefined => (
    typeof session?.projectionValues?.agentPreset === 'string'
      ? session.projectionValues.agentPreset
      : undefined
  )

  /** The workspace a session belongs to, when it belongs to one. */
  const workspaceOf = (sessionId: string): string | undefined => {
    const items = service<WorkspacesService>('workspaces')?.list.getSnapshot().items ?? []
    return items.find(item => item.sessionIds.includes(sessionId))?.workspaceId
  }

  /**
   * Whether a pick crosses the arbor boundary on a session that has not started.
   *
   * Only that case is worth a new session: crossing the boundary is the one
   * thing that cannot be done in place, because DSH cannot keep one agent object
   * across it (`AgentRegistry.enter` refuses a second entry for one id, and the
   * only public release, `AgentHandle.dispose()`, also removes the Session from
   * the store). A session that has already started a turn is refused by DSH's
   * own preset registry before it is committed
   * (`@deepseek-ai/dsh-agent-preset-registry`, `lib/index.js`: `select` throws
   * `agent-preset/locked` once `turnBoundaryOf` reports a turn), so the guard
   * here is the blank-session check rather than a turn boundary this package
   * cannot read.
   */
  const crossesArbor = (id: string): boolean => {
    const main = mainSession()
    if (main === undefined || main.blank !== true) return false
    return (presetOf(main) === ARBOR_PRESET) !== (id === ARBOR_PRESET)
  }

  /**
   * Carry the composer's draft from the session a mint replaces to the minted
   * one, the way DSH's own workspace switch carries it: the input shell's
   * `draftSnapshot` and `attachmentIds` move across, and the old shell is
   * cleared. Without this, a user who typed before switching preset would lose
   * the text to a session swap, which is not something DSH's own preset chip
   * ever did — the chip never changed the session.
   *
   * The minted session's shell appears only once the main view has retained it,
   * so it is waited for against a deadline; a session that never acquires one
   * simply keeps an empty composer.
   */
  const carryDraft = async (from: string, to: string): Promise<void> => {
    const input = service<ConversationService>('conversation')?.input
    if (input === undefined) return
    let draft: { text?: string } | undefined
    let attachmentIds: readonly string[] = []
    try {
      const shell = input.shell(from)
      draft = shell.draftSnapshot
      attachmentIds = shell.snapshot?.attachmentIds ?? []
    } catch {
      // The replaced session has no binding left to read a draft from.
      return
    }
    if ((draft?.text ?? '') === '' && attachmentIds.length === 0) return
    const sessions = service<SessionsService>('sessions')
    const deadline = Date.now() + CARRY_MS
    for (;;) {
      if (sessions?.binding(to) !== undefined) {
        try {
          const next = input.shell(to)
          if (attachmentIds.length === 0 || next.addAttachments(attachmentIds)) {
            next.setDraft(draft ?? { text: '' })
          }
        } catch {
          // The minted session lost its binding before the draft landed.
        }
        return
      }
      if (Date.now() >= deadline) return
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  }

  /**
   * Mint a session created under the picked preset and make it the hero's.
   *
   * The create goes through the client's own `sessions.create`
   * (`@deepseek-ai/dsh-cordis-client-runner`, `lib/client.js`, `ISessions`),
   * which is the `session/create` remote verb, and with no `sessionId` the host
   * mints one: `createSession` → `createMinted(request.cwd,
   * await this.composeAgent(request.agentPreset))`
   * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`). The
   * composition's preset therefore lands in the creation `meta`, which is what
   * `ArborAgentRegistry.create` routes on — so the session runs the driver it
   * was created under and there is nothing to re-route.
   *
   * Opening the minted session changes the hero's session id, which is what
   * re-resolves its session scope: the composer's props are materialized per
   * session binding, and a new id means a new binding. The blank it replaces is
   * archived so the workspace does not collect one blank per pick.
   *
   * @returns whether the pick was taken over here; false leaves the caller to
   *   run DSH's own select.
   */
  const mintUnderPreset = async (id: string): Promise<boolean> => {
    const main = mainSession()
    const sessions = service<SessionsService>('sessions')
    const navigation = service<WorkspaceNavigation>('uiWorkspace')
    if (main === undefined || sessions === undefined || navigation === undefined) return false
    const workspaceId = workspaceOf(main.id)
    try {
      const minted = await sessions.create(workspaceId === undefined
        ? { cwd: main.cwd, agentPreset: id }
        : { workspaceId, agentPreset: id })
      navigation.openSession(minted)
      await carryDraft(main.id, minted)
      // The same call the session row's own archive action makes. The replaced
      // blank's agent stays live for the process, exactly as it does for any
      // blank a user archives by hand: `workspace/archiveSession` only records
      // the archive (`@deepseek-ai/dsh-api-workspace-controller`, `lib/index.js`).
      await navigation.archiveSession(main.id).catch(() => undefined)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(
        `arbor-ui: minting a session under preset ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /**
   * Shadow the hero agent-preset seat with a wrapped `select`.
   *
   * The seat is a `single` slot with no children table
   * (`@deepseek-ai/dsh-client-ui-conversation`, `lib/client.js`, the `children`
   * table: `conversation.hero.agentPreset`, `kind: "single"`,
   * `scope: "session-maybe"`), so a registration at a lower priority shadows it
   * exactly the way the permission seat is shadowed below. Everything but the
   * inject is carried over — the shipped component, its locale — so the chip is
   * the shipped one in every other respect, and only the commit is intercepted.
   *
   * It is registered after the shipped face has been captured above, so the
   * wrapper reads the shipped inject rather than its own: `entriesOfSlot`
   * reports one occupant per `single` slot, the lowest priority, which is this
   * package's own entry from here on.
   */
  const tryShadowHeroSeat = (): void => {
    if (heroDispose !== undefined) return
    if (++heroAttempts > MAX_POLLS) return
    const entry = slots.entriesOfSlot(HERO_SEAT_SLOT)[0]
    if (entry === undefined) return
    const shipped = entry.inject as AgentPresetSeatInject | undefined
    if (typeof shipped !== 'function') return
    const wrapped: AgentPresetSeatInject = (sessionId?: string) => {
      const face = shipped(sessionId)
      const select = face.select
      if (typeof select !== 'function') return face
      return {
        ...face,
        select: (id: string): unknown => {
          if (!crossesArbor(id)) return select(id)
          // The mint is asynchronous and the pick is not committed here, so the
          // chip shows the new preset only once the minted session is main — it
          // reads that session's own committed preset, which is the picked one.
          // A mint that fails falls back to DSH's own select rather than
          // dropping the user's click.
          void mintUnderPreset(id).then(taken => { if (!taken) void select(id) })
          return undefined
        },
      }
    }
    heroDispose = slots.register({
      name: HERO_SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: entry.locale,
      inject: wrapped,
    }, entry.component)
  }

  const tryRegister = (): void => {
    if (dispose !== undefined) { stop(); return }
    if (++attempts > MAX_POLLS) { stop(); return }
    // The hero seat is registered by the same deferred timeline as the seat this
    // package shadows, so wait for it rather than gate on a projection that has
    // not caught up yet. A deployment with no agent-preset surface never supplies
    // it and falls through to the projection alone once the poll is spent.
    if (heroInject === undefined) {
      const face = slots.entriesOfSlot(HERO_SEAT_SLOT)[0]?.inject
      if (typeof face === 'function') heroInject = face as AgentPresetSeatInject
      if (heroInject === undefined) return
    }
    // The lowest-priority occupant is the shipped seat until this gate exists, so
    // reading it here captures `PermissionSelect`, never this package's own gate.
    const seat = slots.entriesOfSlot(SEAT_SLOT)[0]
    if (seat === undefined) return
    dispose = slots.register({
      name: SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: seat.locale,
      inject: seat.inject,
    }, gate(seat))
    // The hero seat is shadowed only after the shipped face above has been
    // captured, so the wrapper reads the shipped inject rather than its own.
    tryShadowHeroSeat()
    stop()
  }

  // The shipped occupants are registered by their own deferred `inject`, which
  // fires on a timeline this package cannot subscribe to, so look for them until
  // they appear. The poll is cheap, bounded, and stops on success; it is also
  // stopped when this plugin is disposed.
  ctx.effect(() => () => { stop() })
  poll = setInterval(tryRegister, POLL_MS)
  tryRegister()
}
