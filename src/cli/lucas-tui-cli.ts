import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { runTui } from "../tui/tui.js";

export function registerLucasTuiCli(program: Command) {
  program
    .command("lucas")
    .description("Open a terminal UI for Lucas (family AI companion) — routes via Gateway")
    .option("--message <text>", "Send an initial message after connecting")
    .option("--thinking <level>", "Thinking level override")
    .action(async (opts) => {
      try {
        await runTui({
          session: "agent:lucas:main",
          message: opts.message as string | undefined,
          thinking: opts.thinking as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
