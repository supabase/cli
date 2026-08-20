import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { OutputFormatFlag } from "../../shared/cli/global-flags.ts";
import { AiTool } from "../../shared/telemetry/ai-tool.service.ts";
import { aiToolLayer } from "../../shared/telemetry/ai-tool.layer.ts";
import { isBuiltInTextRequest, resolveAgentOutputFormat } from "../../shared/cli/agent-output.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { branchesCommand } from "../commands/branches/branches.command.ts";
import { functionsCommand } from "../commands/functions/functions.command.ts";
import { issueCommand } from "../commands/issue/issue.command.ts";
import { linkCommand } from "../commands/link/link.command.ts";
import { initCommand } from "../commands/init/init.command.ts";
import { listCommand } from "../commands/list/list.command.ts";
import { loginCommand } from "../commands/login/login.command.ts";
import { logoutCommand } from "../commands/logout/logout.command.ts";
import { logsCommand } from "../commands/logs/logs.command.ts";
import { apiCommand } from "../commands/platform/api.command.ts";
import { servicesCommand } from "../commands/services/services.command.ts";
import { startCommand } from "../commands/start/start.command.ts";
import { statusCommand } from "../commands/status/status.command.ts";
import { stopCommand } from "../commands/stop/stop.command.ts";
import { telemetryCommand } from "../commands/telemetry/telemetry.command.ts";
import { unlinkCommand } from "../commands/unlink/unlink.command.ts";
import { updateCommand } from "../commands/update/update.command.ts";
import { outputLayerFor } from "../../shared/output/output.layer.ts";
import { jsonCliOutputFormatter } from "../../shared/output/json-formatter.ts";

const stackCommand = Command.make("stack").pipe(
  Command.withDescription("Manage the local Supabase runtime for this project."),
  Command.withShortDescription("Manage local stack lifecycle and versions"),
  Command.withSubcommands([startCommand, stopCommand, statusCommand, listCommand, updateCommand]),
);

export const nextRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    initCommand,
    loginCommand,
    logoutCommand,
    telemetryCommand,
    issueCommand,
    functionsCommand,
    branchesCommand,
    linkCommand,
    unlinkCommand,
    servicesCommand,
    stackCommand,
    startCommand,
    stopCommand,
    statusCommand,
    logsCommand,
    apiCommand,
  ]),
  Command.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const explicitOutputFormat = yield* OutputFormatFlag;
        const cliArgs = yield* CliArgs;
        const aiTool = yield* AiTool.pipe(Effect.provide(aiToolLayer));
        const outputFormat = resolveAgentOutputFormat({
          explicitOutputFormat,
          detectedAgentName: aiTool.name,
          isBuiltInTextRequest: isBuiltInTextRequest(cliArgs.args),
        });
        const base = outputLayerFor(outputFormat);
        if (outputFormat === "text") return base;
        return Layer.merge(base, CliOutput.layer(jsonCliOutputFormatter()));
      }),
    ),
  ),
  Command.withGlobalFlags([OutputFormatFlag]),
);
