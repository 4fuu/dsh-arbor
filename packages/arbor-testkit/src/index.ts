/**
 * B1 testkit: boot a DSH profile with the arbor bundle patch, a memory journal
 * and a scripted model.
 */

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
