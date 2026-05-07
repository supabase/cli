import { unixHttpClientLayer } from "@supabase/stack";
import { DEFAULT_MANAGED_STACK_NAME } from "@supabase/stack/effect";
import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { provideProjectCommandRuntime } from "../../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { parcelFileWatcherLayer } from "../../../../shared/runtime/parcel-file-watcher.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { functionsDev } from "./dev.handler.ts";
import { functionsDevRuntimeLayer } from "./functions-dev-runtime.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
  envFile: Flag.string("env-file").pipe(
    Flag.withDescription("Path to an env file to populate the Function environment."),
    Flag.optional,
  ),
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for locally served Functions."),
  ),
} as const;

export type FunctionsDevFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const functionsDevCommand = Command.make("dev", flags).pipe(
  Command.withDescription(
    "Run local Edge Functions development.\n\n" +
      "Starts the local Supabase stack when needed, configures edge-runtime to serve local Functions, watches function files, and restarts edge-runtime on changes.",
  ),
  Command.withShortDescription("Develop Edge Functions locally"),
  Command.withExamples([
    {
      command: "supabase functions dev",
      description: "Start the local stack if needed and serve local Edge Functions",
    },
    {
      command: "supabase functions dev --env-file ./supabase/functions/.env.local",
      description: "Serve Functions with a custom environment file",
    },
  ]),
  Command.withHandler((flags) =>
    functionsDev(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(
    provideProjectCommandRuntime(
      Layer.mergeAll(
        functionsDevRuntimeLayer,
        commandRuntimeLayer(["functions", "dev"]),
        parcelFileWatcherLayer,
      ),
    ).pipe(Layer.provide(unixHttpClientLayer)),
  ),
);
