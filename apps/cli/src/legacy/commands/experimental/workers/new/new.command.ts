import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { WORKER_RUNTIMES, WORKER_SIZES } from "../../../../../shared/workers/worker-runtimes.ts";
import { legacyCliSettingsLayer } from "../../../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../telemetry/legacy-telemetry-state.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersNew } from "./new.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Worker name. Doubles as its directory, and its hostname."),
  ),
  runtime: Flag.choice("runtime", WORKER_RUNTIMES).pipe(
    Flag.withDescription(
      "Runtime to scaffold and record in supabase/config.toml. Prompted when omitted.",
    ),
    Flag.optional,
  ),
  size: Flag.choice("size", WORKER_SIZES).pipe(
    Flag.withDescription(
      "Instance size to record in supabase/config.toml. Each size implies its own vCPU count, so there is no separate --cpu. Prompted when omitted.",
    ),
    Flag.optional,
  ),
  source: Flag.string("source").pipe(
    Flag.withDescription(
      "Scaffold the worker here instead of the default workers directory, recorded as `source` in supabase/config.toml.",
    ),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

/** Local-disk only: no Management API, so no platform stack is built. */
const legacyWorkersNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["experimental", "workers", "new"]),
);

export const legacyWorkersNewCommand = Command.make("new", config).pipe(
  Command.withDescription(
    "Scaffold a worker directory from a runtime's starter files and record the choice in supabase/config.toml. Nothing is deployed.",
  ),
  Command.withShortDescription("Scaffold a worker locally"),
  Command.withExamples([
    {
      command: "supabase experimental workers new api",
      description: "Scaffold supabase/workers/api, prompting for runtime and size",
    },
    {
      command: "supabase experimental workers new api --runtime node",
      description: "Scaffold supabase/workers/api on the node runtime",
    },
    {
      command: "supabase experimental workers new api --source packages/api",
      description: "Scaffold the worker outside the workers directory",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersNew(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyWorkersNewRuntimeLayer),
);
