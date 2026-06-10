import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { makeGoProxyLayer } from "../../../../shared/legacy/go-proxy.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
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
  ),
  useDocker: Flag.boolean("use-docker").pipe(
    Flag.withDescription("Use Docker to unbundle functions client-side."),
    Flag.withHidden,
  ),
  legacyBundle: Flag.boolean("legacy-bundle").pipe(
    Flag.withDescription("Use legacy bundling mechanism."),
    Flag.withHidden,
  ),
} as const;

export type FunctionsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

const functionsDownloadRuntimeLayer = Layer.mergeAll(
  BunServices.layer,
  platformApiLayer.pipe(Layer.provide(credentialsLayer)),
  projectLinkStateLayer,
  commandRuntimeLayer(["functions", "download"]),
  makeGoProxyLayer(),
);

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
    functionsDownload(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(functionsDownloadRuntimeLayer),
);
