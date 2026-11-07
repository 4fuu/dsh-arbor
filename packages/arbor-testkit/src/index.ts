/**
 * B1 testkit: boot a DSH profile with the arbor bundle patch, a memory journal
 * and a scripted model.
 */

import { fileURLToPath } from 'node:url'

export { bootArborProfile, freshDshHome, installAnchor, arborPatch } from './boot.ts'
export { finishProof } from './finish.ts'
export type { ArborProfileOptions } from './boot.ts'
export {
  arborDriverOf,
  agentPresetsOf,
  arborHostOf,
  sessionArborOf,
  waitFor,
  windowOf,
} from './access.ts'
export { MemoryJournal } from './journal.ts'
export {
  ScriptedAdapter,
  ScriptedLlm,
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  SCRIPTED_SELECTION,
  proofLive,
  installScriptedLlm,
} from './scripted-llm.ts'
export type { ScriptedResponse } from './scripted-llm.ts'
export { scriptedLlm, holdSpikeTools, spikeApprovalAsks, spikeToolRuns, ScriptedLlmService } from './scripted-plugin.ts'
export { ACME_POLICY_TEXT, SpikePromptSectionService } from './prompt-sections.ts'

// The B3 fixtures: one DSH skill on ctx.skills, and the MCP server a real
// mcp-client row connects to (patches/arbor.patch.yml names the script through
// ARBOR_FIXTURES, which a proof sets before it boots).
export { PROBE_SKILL, DshProbeSkillService, probeSkillRegistrations } from './fixtures/dsh-skill.ts'

/**
 * The directory the B3 fixture files live in.
 *
 * The `arbor.patch.yml` overlay names the fixture MCP server's script through
 * the `ARBOR_FIXTURES` environment variable, because a patch's `!!js` expression
 * is evaluated with `new Function` and cannot reach `import.meta.url`. A proof
 * that boots the overlay calls {@link useDshFixtures} first.
 */
export const FIXTURES_DIR: string = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** Point the B3 fixture overlay at this checkout's fixture files. */
export function useDshFixtures(): void {
  process.env['ARBOR_FIXTURES'] = FIXTURES_DIR
}
