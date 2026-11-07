/**
 * B0 spike testkit: boot a DSH profile with arbor overlay patches, a memory
 * journal, and a scripted model.
 */

export { bootArborProfile, freshDshHome, installAnchor } from './boot.ts'
export type { ArborProfileOptions } from './boot.ts'
export { MemoryJournal } from './journal.ts'
export {
  ScriptedAdapter,
  ScriptedLlm,
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  SCRIPTED_SELECTION,
  installScriptedLlm,
} from './scripted-llm.ts'
export type { ScriptedResponse } from './scripted-llm.ts'
export { scriptedLlm, spikeApprovalAsks, spikeToolRuns, ScriptedLlmService } from './scripted-plugin.ts'
