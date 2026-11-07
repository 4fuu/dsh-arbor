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
 *    registration options (its inject face and locale) are readable through
 *    `ctx.slots.entriesOfSlot`.
 *  - The session's picked preset is a per-session projection,
 *    `useProjection("agentPreset")`, whose value is the preset id — `"arbor"`
 *    for an arbor session, the embedded loop's id otherwise. The composer's own
 *    preset selector reads the same projection, so the gate below reads exactly
 *    what the user picked.
 *
 * So this package registers its own occupant of that seat one priority below
 * the shipped one, reusing the shipped component, inject face and locale: the
 * real `PermissionSelect` for an ordinary session, and nothing for an arbor
 * one. The shipped occupant registers through permission-presets' own deferred
 * `inject`, on a timeline this package does not observe through a slot
 * subscription, so the shipped occupant is read by polling `entriesOfSlot`
 * until it appears and then captured; the poll stops the moment the gate is
 * registered. permission-presets stays enabled, so its `/permission` popup and
 * General-settings row are untouched for both.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'

/** The composer seat DSH's permission-presets package occupies. */
const SEAT_SLOT = 'conversation.input.permission'

/** The agent-preset id whose sessions have no DSH sandbox and hide the control. */
const ARBOR_PRESET = 'arbor'

/** How often to look for the shipped occupant before giving up. */
const POLL_MS = 40

/** Give up looking for the shipped occupant after this many polls (~20s). */
const MAX_POLLS = 500

/** Required client services. */
export const inject: readonly string[] = ['slots']

/** One `single`-slot occupant as `entriesOfSlot` reports it. */
interface SeatEntry {
  readonly component: (props: never) => unknown
  readonly options: {
    readonly priority?: number
    readonly locale?: unknown
    readonly inject?: unknown
  }
}

/**
 * The slice of the client slots service this package uses. `ctx.slots` is added
 * to the cordis Context by `@deepseek-ai/dsh-client-ui-slots`' module
 * augmentation, a type-only package this bridge does not depend on at runtime,
 * so the few members used here are declared locally rather than imported.
 */
interface SlotsService {
  entriesOfSlot(name: string): readonly SeatEntry[]
  register(
    options: { name: string; priority?: number; locale?: unknown; inject?: unknown },
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

  // Register this package's occupant one priority below the shipped seat, reusing
  // the shipped component, inject face and locale so an ordinary session renders
  // the identical control and only an arbor session renders nothing.
  const gate = (seat: SeatEntry) => (props: never): unknown => {
    // `useProjection` is the same slot-runtime hook the captured seat uses; the
    // `agentPreset` projection is the id the composer's preset selector shows.
    const preset = (props as { useProjection?: (key: string) => unknown }).useProjection?.('agentPreset')
    if (preset === ARBOR_PRESET) return null
    return createElement(seat.component as unknown as ComponentType, props as Record<string, unknown>)
  }

  const tryRegister = (): void => {
    if (dispose !== undefined) { stop(); return }
    if (++attempts > MAX_POLLS) { stop(); return }
    // The lowest-priority occupant is the shipped seat until this gate exists, so
    // reading it here captures `PermissionSelect`, never this package's own gate.
    const seat = slots.entriesOfSlot(SEAT_SLOT)[0]
    if (seat === undefined) return
    dispose = slots.register({
      name: SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: seat.options.locale,
      inject: seat.options.inject,
    }, gate(seat))
    stop()
  }

  // The shipped occupant is registered by permission-presets' own deferred
  // `inject`, which fires on a timeline this package cannot subscribe to, so
  // look for it until it appears. The poll is cheap, bounded, and stops on
  // success; it is also stopped when this plugin is disposed.
  ctx.effect(() => () => { stop() })
  poll = setInterval(tryRegister, POLL_MS)
  tryRegister()
}
