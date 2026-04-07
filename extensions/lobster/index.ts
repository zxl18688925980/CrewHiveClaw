import type {
  AnyAgentTool,
  CrewClawPluginApi,
  CrewClawPluginToolFactory,
} from "openclaw/plugin-sdk/lobster";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: CrewClawPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api) as AnyAgentTool;
    }) as CrewClawPluginToolFactory,
    { optional: true },
  );
}
