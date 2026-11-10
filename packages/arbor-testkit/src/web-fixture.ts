/**
 * A search provider for the proofs, so `web_search` is admitted without a
 * DeepSeek credential.
 *
 * DSH's own `tool-web` row keeps `web_search` registered but a model step does
 * not admit it while `ctx.web.searchReady()` says the selected provider cannot
 * authenticate. `patches/web-fixture.patch.yml` points the web seam's
 * `searchProvider` at this fixture, which reports ready unconditionally and
 * answers from memory; every proof therefore sees the same tool set whether or
 * not the developer or CI runner has a key.
 *
 * Only the search capability is overridden. Fetch stays on DSH's `http`
 * provider, so `web_fetch` is the real one and needs no fixture either way.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'

/** The provider id `patches/web-fixture.patch.yml` selects. */
export const WEB_FIXTURE_PROVIDER = 'arbor-proof-search'

/** The row that registers the proof's search provider on `ctx.web`. */
export class ArborWebFixtureService extends Service {
  static inject = ['web']

  constructor(ctx: Context) {
    super(ctx, 'arborWebFixture')
  }

  protected [Service.init](): void {
    const provider: WebSearchProvider = {
      id: WEB_FIXTURE_PROVIDER,
      available: () => true,
      search: async (request) => ({
        sources: [
          {
            url: 'https://example.com/arbor-proof',
            title: 'arbor proof result',
            snippet: `proof result for: ${request.query}`,
          },
        ],
        truncated: false,
      }),
    }
    this.ctx.web.registerSearchProvider(provider)
  }
}

export default ArborWebFixtureService
