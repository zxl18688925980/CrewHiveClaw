import type { CrewClawConfig } from "../../config/config.js";

export function createPerSenderSessionConfig(
  overrides: Partial<NonNullable<CrewClawConfig["session"]>> = {},
): NonNullable<CrewClawConfig["session"]> {
  return {
    mainKey: "main",
    scope: "per-sender",
    ...overrides,
  };
}
