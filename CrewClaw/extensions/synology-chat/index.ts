import type { CrewClawPluginApi } from "openclaw/plugin-sdk/synology-chat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/synology-chat";
import { createSynologyChatPlugin } from "./src/channel.js";
import { setSynologyRuntime } from "./src/runtime.js";

const plugin = {
  id: "synology-chat",
  name: "Synology Chat",
  description: "Native Synology Chat channel plugin for CrewClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: CrewClawPluginApi) {
    setSynologyRuntime(api.runtime);
    api.registerChannel({ plugin: createSynologyChatPlugin() });
  },
};

export default plugin;
