import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { OutputFormatFlag, SkillDirFlag, SkillFlag, UsageFlag } from "./global-flags.ts";
import { loginCommand } from "../commands/login/login.command.ts";
import { logsCommand } from "../commands/logs/logs.command.ts";
import { platformCommand } from "../commands/platform/platform.command.ts";
import { startCommand } from "../commands/start/start.command.ts";
import { statusCommand } from "../commands/status/status.command.ts";
import { stopCommand } from "../commands/stop/stop.command.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";

export const root = Command.make("supabase").pipe(
  Command.withSubcommands([
    loginCommand,
    startCommand,
    stopCommand,
    statusCommand,
    logsCommand,
    platformCommand,
  ]),
  Command.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const outputFormat = yield* OutputFormatFlag;
        const base = outputLayerFor(outputFormat);
        if (outputFormat === "text") return base;
        return Layer.merge(base, CliOutput.layer(jsonCliOutputFormatter()));
      }),
    ),
  ),
  Command.withGlobalFlags([OutputFormatFlag, UsageFlag, SkillFlag, SkillDirFlag]),
);
