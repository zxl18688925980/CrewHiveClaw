import type { CrewClawConfig } from "../config/config.js";
import { loadCrewClawPlugins } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

export function ensureRuntimePluginsLoaded(params: {
  config?: CrewClawConfig;
  workspaceDir?: string | null;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;

  loadCrewClawPlugins({
    config: params.config,
    workspaceDir,
  });
}
