import type { CrewClawPluginApi } from "../../src/plugins/types.js";

type TestPluginApiInput = Partial<CrewClawPluginApi> &
  Pick<CrewClawPluginApi, "id" | "name" | "source" | "config" | "runtime">;

export function createTestPluginApi(api: TestPluginApiInput): CrewClawPluginApi {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
    ...api,
  };
}
