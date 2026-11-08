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
 * ## What this package does not do yet, and why
 *
 * The project-picker filter — arbor's shared-folder projects for an arbor
 * composer, nothing from arbor's tree for an ordinary one — is not here. The
 * picker seat (`conversation.hero.workspace`) declares a child slot
 * (`conversation.hero.workspace.directoryFlow`), and DSH's `SlotCore.register`
 * refuses a second declaration of a child key that is already declared
 * (`@deepseek-ai/dsh-client-ui-slots`, `lib/index.js`), so an occupant cannot
 * be shadowed without re-declaring it; and an occupant registered without the
 * children table has no `renderSlot`, so the shipped `WorkspacePicker` throws
 * on its own directory flow and the slot's supervision abdicates it. Shadowing
 * that seat therefore needs a seam DSH does not offer today — see
 * `docs/b3b-projects-and-sandbox.md`.
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

/** Required client services. */
export const inject: readonly string[] = ['slots']

/**
 * One `single`-slot occupant as `entriesOfSlot` reports it: the component, the
 * registration's inject face and locale namespace, and the option bag (which
 * carries the slot's own `key`/`order`/`priority` and nothing else).
 */
interface SeatEntry {
  readonly component: (props: never) => unknown
  readonly inject?: unknown
  readonly locale?: unknown
  readonly options: {
    readonly priority?: number
    readonly locale?: unknown
    readonly inject?: unknown
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
}

/** The hero seat's `inject`, called the way the slot runtime calls it. */
type AgentPresetSeatInject = (sessionId?: string) => AgentPresetSeatInjected

/**
 * The slice of the client slots service this package uses. `ctx.slots` is added
 * to the cordis Context by `@deepseek-ai/dsh-client-ui-slots`' module
 * augmentation, a type-only package this bridge does not depend on at runtime,
 * so the few members used here are declared locally rather than imported.
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
  let dispose: (() => void) | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let attempts = 0

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
    // The staged pick decides for a composer whose session has not committed it
    // yet; the projection decides for one that has. Either naming arbor means
    // the session this composer belongs to runs arbor.
    const staged = usePresetPick(runtime.sessionId)
    const projected = runtime.useProjection?.(PRESET_PROJECTION)
    if (staged === ARBOR_PRESET || projected === ARBOR_PRESET) return null
    return createElement(seat.component as unknown as ComponentType, props as Record<string, unknown>)
  }

  /**
   * Subscribe this render to the hero chip's staged pick for one session.
   *
   * Both the seat bound to the composer's session and the unbound seat are
   * read, because the hero chip is bound while a blank session is current and
   * unbound before one exists; either store naming arbor is the answer. The
   * unbound store answers the Host-effective default when nothing is staged, so
   * it never invents an arbor session.
   */
  function usePresetPick(sessionId: string | undefined): string | undefined {
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
      },
    )
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
