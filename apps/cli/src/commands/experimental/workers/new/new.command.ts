import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { workersCommandLine } from "../workers.command-line.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  WORKER_EXPOSURES,
  WORKER_RUNTIMES,
  WORKER_SIZES,
} from "../../../../shared/workers/worker-runtimes.ts";
import { commandSettingsLayer } from "../../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { workersNew } from "./new.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription(
      "Worker name. Doubles as its directory, and its hostname. Prompted when omitted.",
    ),
    Argument.optional,
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
  exposure: Flag.choice("exposure", WORKER_EXPOSURES).pipe(
    Flag.withDescription(
      "Whether the worker is reachable from the internet, recorded as `exposure` in supabase/config.toml. Prompted when omitted.",
    ),
    Flag.optional,
  ),
  instances: Flag.integer("instances").pipe(
    // Bounded at the parser, the same way `push --instances` and the config
    // schema's own `instances` are.
    Flag.filter(
      (instances) => instances >= 0,
      (instances) => `--instances ${instances} is negative; pass zero or more.`,
    ),
    Flag.withDescription(
      "Number of instances to record in supabase/config.toml. Not prompted for, and recorded only when it differs from the default of 1.",
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

export type WorkersNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

/** Local-disk only: no Management API, so no platform stack is built. */
const workersNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["experimental", "workers", "new"]),
);

export const workersNewCommand = Command.make("new", config).pipe(
  Command.withDescription(
    "Scaffold a worker directory from a runtime's starter files and record the choices in supabase/config.toml. Nothing is deployed.",
  ),
  Command.withShortDescription("Scaffold a worker locally"),
  Command.withExamples([
    {
      command: workersCommandLine("new"),
      description: "Prompt for the name, then for runtime, size and exposure",
    },
    {
      command: workersCommandLine("new api"),
      description: "Scaffold supabase/workers/api, prompting for runtime, size and exposure",
    },
    {
      command: workersCommandLine("new api --runtime node"),
      description: "Scaffold supabase/workers/api on the node runtime",
    },
    {
      command: workersCommandLine("new api --exposure private"),
      description: "Scaffold a worker with no internet-facing URL",
    },
    {
      command: workersCommandLine("new api --instances 3"),
      description: "Scaffold a worker that deploys at three instances",
    },
    {
      command: workersCommandLine("new api --source packages/api"),
      description: "Scaffold the worker outside the workers directory",
    },
  ]),
  Command.withHandler((flags) =>
    workersNew(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(workersNewRuntimeLayer),
);
