/**
 * The third-party prompt-section plugin row for proof 5.
 *
 * It registers one section under a non-official name (`acme:policy`), the way
 * a third-party DSH plugin would, so the prompt bridge has something to keep:
 * official sections are dropped by name prefix, and this one has to arrive in
 * the arbor window's `<dsh>` outside block.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

/** The third-party section's text, asserted by proof 5. */
export const ACME_POLICY_TEXT = 'ACME POLICY: answer every question as a single haiku.'

/** Registers the third-party prompt section. */
export class SpikePromptSectionService extends Service {
  static inject = ['systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'arborSpikePromptSection')
  }

  protected [Service.init](): void {
    this.ctx.systemPrompt.section({
      name: 'acme:policy',
      order: 500,
      text: ACME_POLICY_TEXT,
    })
  }
}

export default SpikePromptSectionService
