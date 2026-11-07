/**
 * Typed accessors for the arbor rows a booted profile mounts, plus the waits a
 * proof needs around them. The proofs read the host and the driver through
 * these instead of casting, so a rename is one edit here rather than one per
 * proof.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ArborHostService } from '@4fu/dsh-arbor-host'
import type { ArborDriver, SessionArborLike } from '@4fu/dsh-arbor-driver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WindowRef } from '@4fu/arbor-interfaces'

/** The booted arbor host service. */
export function arborHostOf(ctx: Context): ArborHostService {
  const host = ctx.get('arborHost') as ArborHostService | undefined
  if (host === undefined) throw new Error('no arborHost service: is the arbor bundle patch mounted?')
  return host
}

/** The booted arbor driver. */
export function arborDriverOf(ctx: Context): ArborDriver {
  const driver = ctx.get('arborDriver') as ArborDriver | undefined
  if (driver === undefined) throw new Error('no arborDriver service: is the arbor bundle patch mounted?')
  return driver
}

/** The per-session arbor world of one session, once the driver has one. */
export function sessionArborOf(ctx: Context, sessionId: SessionId): SessionArborLike | undefined {
  return arborDriverOf(ctx).sessionArbor(sessionId)
}

/** The window one session's work runs in, once it has opened one. */
export function windowOf(ctx: Context, sessionId: SessionId): WindowRef | undefined {
  return sessionArborOf(ctx, sessionId)?.windowRef
}

/** Poll until `read` answers something other than undefined, or the deadline passes. */
export async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor: the value never appeared')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
