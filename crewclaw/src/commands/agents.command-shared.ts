import type { CrewClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { requireValidConfigSnapshot } from "./config-validation.js";

export function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return { ...runtime, log: () => {} };
}

export async function requireValidConfig(runtime: RuntimeEnv): Promise<CrewClawConfig | null> {
  return await requireValidConfigSnapshot(runtime);
}
