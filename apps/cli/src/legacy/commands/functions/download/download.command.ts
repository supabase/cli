import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyFunctionsDownload } from "./download.handler.ts";

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
  ),
  useDocker: Flag.boolean("use-docker").pipe(
    Flag.withDescription("Use Docker to unbundle functions locally."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  legacyBundle: Flag.boolean("legacy-bundle").pipe(
    Flag.withDescription("Use legacy bundling."),
    Flag.withHidden,
  ),
} as const;

export type LegacyFunctionsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFunctionsDownloadHandler = (flags: LegacyFunctionsDownloadFlags) =>
  legacyFunctionsDownload(flags).pipe(
    withLegacyCommandInstrumentation({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
    withJsonErrorHandling,
  );

export const legacyFunctionsDownloadCommand = Command.make("download", config).pipe(
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
  Command.withHandler(legacyFunctionsDownloadHandler),
  Command.provide(legacyManagementApiRuntimeLayer(["functions", "download"])),
);
