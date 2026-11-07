/**
 * The third-party prompt-section plugin row.
 *
 * It registers one section under a name of a third party's own (`acme:policy`),
 * the way any DSH plugin would, so the prompt bridge has third-party material
 * to route into the `<dsh>` data block. Proof 11 boots it beside the MCP
 * fixture, which is the fifth case the owner reviews: one MCP server and one
 * third-party plugin installed.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

/** The third-party section's text, asserted by proof 11. */
export const THIRD_PARTY_TEXT = 'ACME POLICY: answer every question as a single haiku.'

/** Registers the third-party prompt section. */
export class ArborThirdPartySectionService extends Service {
  static inject = ['systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'arborThirdPartySection')
  }

  protected [Service.init](): void {
    this.ctx.systemPrompt.section({
      name: 'acme:policy',
      order: 500,
      text: THIRD_PARTY_TEXT,
    })
  }
}

export default ArborThirdPartySectionService
