// Narrow plugin-sdk surface for the bundled diffs plugin.
// Keep this list additive and scoped to symbols used under extensions/diffs.

export type { CrewClawConfig } from "../config/config.js";
export { resolvePreferredCrewClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export type {
  AnyAgentTool,
  CrewClawPluginApi,
  CrewClawPluginConfigSchema,
  PluginLogger,
} from "../plugins/types.js";
