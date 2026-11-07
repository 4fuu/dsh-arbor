/**
 * The B0 journal plugin row: provides the in-memory arbor Journal.
 *
 * arbor's core ships no journal — a deployment provides one
 * (docs/architecture.md#interfaces). This row is the B0 stand-in, mounted
 * from the spike's overlay patch so the arbor driver can inject it; B1
 * replaces it with a durable journal in the dsh-arbor host module.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Journal } from '@4fu/arbor-interfaces'
import { MemoryJournal } from './journal.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The arbor journal this deployment provides. */
    arborJournal: ArborJournalService
  }
}

/** Provides one in-memory arbor journal per boot. */
export class ArborJournalService extends Service {
  static inject: readonly string[] = []

  readonly journal: Journal = new MemoryJournal()

  constructor(ctx: Context) {
    super(ctx, 'arborJournal')
  }
}

export default ArborJournalService
