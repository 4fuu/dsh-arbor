/**
 * The B3 fixtures: one DSH skill and one DSH MCP server, mounted the way a
 * real DSH installation would mount them, so the `/env` proofs read what a
 * deployment really has.
 *
 * The skill is registered on DSH's own `ctx.skills` registry as a runtime
 * contribution (`SkillRegistry.register`, `@deepseek-ai/dsh-skill`,
 * `lib/types/index.d.ts`) — the same call a DSH plugin's `apply` makes — so the
 * mount reads it through `ctx.skills.list` and `ctx.skills.get` exactly as it
 * reads a filesystem provider's.
 *
 * The MCP server is a real `mcp-client` row, declared in
 * `patches/dsh-env.patch.yml`, connected to `fixtures/mcp-server.mjs`. That
 * matters: it publishes a genuine `mcp__probe__echo` tool on `ctx.tools`, which
 * is the only place DSH says which MCP servers exist, and it proves the tools
 * stay DSH tools rather than becoming arbor MCP modules.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** The one skill the fixture registers, and the body it answers with. */
export const PROBE_SKILL = {
  name: 'probe-skill',
  description: 'How the dsh-arbor proof skill works: read this, then echo one line back.',
  body: [
    '# probe-skill',
    '',
    'This is a DSH skill the proof registers, and the only place its body lives.',
    '',
    '1. Read this file, which you have just done.',
    '2. Answer with one line that says you read the probe skill.',
    '',
  ].join('\n'),
}

/** Every run of the fixture skill's registration, for the proof to read. */
export const probeSkillRegistrations: string[] = []

/** The row that registers the probe skill on DSH's own registry. */
export class DshProbeSkillService extends Service {
  static inject = ['skills']

  constructor(ctx: Context) {
    super(ctx, 'arborProbeSkill')
  }

  protected [Service.init](): void {
    this.ctx.skills.register({
      name: PROBE_SKILL.name,
      description: PROBE_SKILL.description,
      source: 'runtime',
      content: PROBE_SKILL.body,
    })
    probeSkillRegistrations.push(PROBE_SKILL.name)
  }
}

export default DshProbeSkillService
