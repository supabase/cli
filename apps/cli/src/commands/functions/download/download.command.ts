import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { functionsDownload as functionsDownloadCalls } from "../../../shared/functions/download.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { removedFlag } from "../../../command-internal/removed-command.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { functionsDownload } from "./download.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  functionName: cliArgument("Function name", Argument.String, {
    description: "Name of the function to download; downloads all when omitted.",
    optional: true,
  }),
  ...projectTargetFlags(),
  useApi: cliFlag("use-api", Flag.Boolean, {
    description: "Unbundle functions server-side without using Docker.",
    default: false,
  }),
  useDocker: cliFlag("use-docker", Flag.Boolean, {
    description: "Unbundle functions locally using Docker.",
    default: true,
    hidden: true,
  }),
  // Kept parsed (and hidden) only so using it produces an actionable removal error instead of
  // an unknown-flag parse error; see `functionsDownloadLegacyBundleHandler`.
  legacyBundle: cliFlag("legacy-bundle", Flag.Boolean, {
    description: "Removed; use `--use-api` instead.",
    optional: true,
    hidden: true,
  }),
} as const;

export type FunctionsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

const functionsDownloadHandler = (flags: FunctionsDownloadFlags) =>
  functionsDownload(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling);

const COMMAND_PATH = ["functions", "download"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);
const removedFlagLayer = Layer.mergeAll(commandRuntimeLayer(COMMAND_PATH), telemetryStateLayer);

// Rejected on a credential-free runtime: `managementApiRuntimeLayer` resolves the access token
// eagerly, so building it first would fail with a login error before the removal message.
const functionsDownloadLegacyBundleHandler = (flags: FunctionsDownloadFlags) => {
  const slug = Option.getOrElse(flags.functionName, () => "<slug>");
  return removedFlag(
    "--legacy-bundle",
    `Retry with \`supabase functions download --use-api ${slug}\` to unbundle server-side without Docker. If that also fails and the Function was deployed with a CLI older than 1.120.0, redeploy it with the current CLI.`,
  ).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling, Effect.provide(removedFlagLayer));
};

export const functionsDownloadCommand = makeCommand("download", config).pipe(
  Command.withDescription(
    "Download the source code of deployed Edge Functions from the linked project. Downloads every function when you omit the name.",
  ),
  Command.withShortDescription("Download Edge Functions from a project"),
  Command.withExamples([
    {
      command: "supabase functions download hello-world",
      description: "Download a single function from the linked project",
    },
    {
      command: "supabase functions download --remote=abcdefghijklmnopqrst",
      description: "Download all functions from a specific project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [],
        noApiEffectFlags: ["use-api", "use-docker", "legacy-bundle"],
      },
      functionsDownloadCalls,
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Option.isSome(flags.legacyBundle)
      ? functionsDownloadLegacyBundleHandler(flags)
      : functionsDownloadHandler(flags).pipe(Effect.provide(managementApiLayer)),
  ),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
