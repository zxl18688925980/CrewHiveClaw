// Narrow plugin-sdk surface for the bundled llm-task plugin.
// Keep this list additive and scoped to symbols used under extensions/llm-task.

export { resolvePreferredCrewClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  supportsXHighThinking,
} from "../auto-reply/thinking.js";
export type { AnyAgentTool, CrewClawPluginApi } from "../plugins/types.js";
