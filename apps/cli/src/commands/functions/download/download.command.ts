import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { removedFlag } from "../../../command-internal/removed-command.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { functionsDownload } from "./download.handler.ts";

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to download. Downloads all if omitted."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  useApi: Flag.boolean("use-api").pipe(
    Flag.withDescription("Unbundle functions server-side without using Docker."),
    Flag.withDefault(false),
  ),
  useDocker: Flag.boolean("use-docker").pipe(
    Flag.withDescription("Use Docker to unbundle functions locally."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  // Kept parsed (and hidden) only so using it produces an actionable removal error instead of
  // an unknown-flag parse error; see `functionsDownloadLegacyBundleHandler`.
  legacyBundle: Flag.boolean("legacy-bundle").pipe(
    Flag.withDescription("Removed: use --use-api instead."),
    Flag.optional,
    Flag.withHidden,
  ),
} as const;

export type FunctionsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const functionsDownloadHandler = (flags: FunctionsDownloadFlags) =>
  functionsDownload(flags).pipe(
    withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
    withJsonErrorHandling,
  );

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
  ).pipe(
    withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
    withJsonErrorHandling,
    Effect.provide(removedFlagLayer),
  );
};

export const functionsDownloadCommand = Command.make("download", config).pipe(
  Command.withDescription(
    "Download the source code for a Function from the linked Supabase project. If no function name is provided, downloads all functions.",
  ),
  Command.withShortDescription("Download a Function from Supabase"),
  Command.withExamples([
    {
      command: "supabase functions download hello-world",
      description: "Download a single function from the linked project",
    },
    {
      command: "supabase functions download --project-ref abcdefghijklmnopqrst",
      description: "Download all functions from a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    Option.isSome(flags.legacyBundle)
      ? functionsDownloadLegacyBundleHandler(flags)
      : functionsDownloadHandler(flags).pipe(Effect.provide(managementApiLayer)),
  ),
);
