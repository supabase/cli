import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { OutputFormatFlag } from "./global-flags.ts";
import { branchesCommand } from "../commands/branches/branches.command.ts";
import { linkCommand } from "../commands/link/link.command.ts";
import { initCommand } from "../commands/init/init.command.ts";
import { listCommand } from "../commands/list/list.command.ts";
import { loginCommand } from "../commands/login/login.command.ts";
import { logoutCommand } from "../commands/logout/logout.command.ts";
import { logsCommand } from "../commands/logs/logs.command.ts";
import { platformCommand } from "../commands/platform/platform.command.ts";
import { startCommand } from "../commands/start/start.command.ts";
import { statusCommand } from "../commands/status/status.command.ts";
import { stopCommand } from "../commands/stop/stop.command.ts";
import { telemetryCommand } from "../commands/telemetry/telemetry.command.ts";
import { unlinkCommand } from "../commands/unlink/unlink.command.ts";
import { updateCommand } from "../commands/update/update.command.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";

const stackCommand = Command.make("stack").pipe(
  Command.withDescription("Manage the local Supabase runtime for this project."),
  Command.withShortDescription("Manage local stack lifecycle and versions"),
  Command.withSubcommands([startCommand, stopCommand, statusCommand, listCommand, updateCommand]),
);

export const root = Command.make("supabase").pipe(
  Command.withSubcommands([
    initCommand,
    loginCommand,
    logoutCommand,
    telemetryCommand,
    branchesCommand,
    linkCommand,
    unlinkCommand,
    stackCommand,
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
  Command.withGlobalFlags([OutputFormatFlag]),
);
