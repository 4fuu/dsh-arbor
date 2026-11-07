/**
 * The MCP-server and third-party-plugin fixture rows.
 *
 * Two rows, in the shape DSH's own packages produce them:
 *
 *  - `arbor-mcp-instructions` registers the instructions a connected MCP
 *    server hands down, under the `mcp:<server>` name
 *    `@deepseek-ai/dsh-mcp-client` uses, and registers the server's tools on
 *    `ctx.tools` under server-qualified public names
 *    (`mcp__<server>__<rawName>`), the same names the real client row
 *    registers. It is a fixture rather than a live connection, so a proof needs
 *    no network server; what it registers is what the bridge has to route.
 *  - `arbor-third-party-section` registers one prompt section under a name of
 *    a third party's own, the way any DSH plugin does.
 *
 * Proof 11 boots both and checks where each lands: the instructions in the
 * `<dsh>` data block, the tools among the model's callable tools.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** The MCP server's name, as its instructions section and its tools name it. */
export const MCP_SERVER_NAME = 'demo'

/** The instructions the fixture server hands down, asserted by proof 11. */
export const MCP_INSTRUCTIONS_TEXT =
  'Demo MCP server: prefer demo_lookup over the web tools for anything about the demo corpus, '
  + 'and cite the ref it returns. Its tools are the only way to read the corpus.'

/** The tool the fixture server exposes, under its server-qualified public name. */
export const MCP_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__lookup`

/** Registers one MCP server's instructions and its tools. */
export class ArborMcpFixtureService extends Service {
  static inject = ['systemPrompt', 'tools']

  constructor(ctx: Context) {
    super(ctx, 'arborMcpFixture')
  }

  protected [Service.init](): void {
    this.ctx.systemPrompt.section({
      name: `mcp:${MCP_SERVER_NAME}`,
      order: this.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: MCP_INSTRUCTIONS_TEXT,
    })
    this.ctx.tools.register({
      name: MCP_TOOL_NAME,
      description: 'Look a term up in the demo corpus. Returns the matching entries with their refs.',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'The term to look up.' },
          limit: { type: 'number', description: 'How many entries to return at most.' },
        },
        required: ['term'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { entries: { type: 'array', items: { type: 'string' } } },
          required: ['entries'],
        },
        render: (_args, value) => [{ type: 'text', text: (value as { entries: string[] }).entries.join('\n') }],
      },
      execute: async (args: unknown) => ({
        entries: [`demo:${(args as { term: string }).term}`],
      }),
    })
  }
}

export default ArborMcpFixtureService
