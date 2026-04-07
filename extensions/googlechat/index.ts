import type { CrewClawPluginApi } from "openclaw/plugin-sdk/googlechat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/googlechat";
import { googlechatDock, googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "googlechat",
  name: "Google Chat",
  description: "CrewClaw Google Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: CrewClawPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel({ plugin: googlechatPlugin, dock: googlechatDock });
  },
};

export default plugin;
