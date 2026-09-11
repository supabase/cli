import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  COMPUTE_EXPOSURES,
  COMPUTE_RUNTIMES,
  COMPUTE_SIZES,
} from "../../../../shared/compute/compute-runtimes.ts";
import { commandSettingsLayer } from "../../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeNew } from "./new.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription(
      "Compute name. Doubles as its directory, and its hostname. Prompted when omitted.",
    ),
    Argument.optional,
  ),
  runtime: Flag.choice("runtime", COMPUTE_RUNTIMES).pipe(
    Flag.withDescription(
      "Runtime to scaffold and record in supabase/config.toml. Prompted when omitted, defaulting to what --template looks like when one is given.",
    ),
    Flag.optional,
  ),
  size: Flag.choice("size", COMPUTE_SIZES).pipe(
    Flag.withDescription(
      "Instance size to record in supabase/config.toml. Each size implies its own vCPU count, so there is no separate --cpu. Prompted when omitted.",
    ),
    Flag.optional,
  ),
  exposure: Flag.choice("exposure", COMPUTE_EXPOSURES).pipe(
    Flag.withDescription(
      "Whether the compute is reachable from the internet, recorded as `exposure` in supabase/config.toml. Prompted when omitted.",
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
      "Scaffold the compute here instead of the default compute directory, recorded as `source` in supabase/config.toml.",
    ),
    Flag.optional,
  ),
  template: Flag.string("template").pipe(
    Flag.withDescription(
      "Bootstrap the compute from a git repository instead of the runtime's starter files: a GitHub owner/repo slug, optionally with a subdirectory and a #ref, or any repository URL git can clone. The repository becomes the compute's entire contents in place of those starter files, and its marker files pick the runtime when --runtime is omitted.",
    ),
    Flag.optional,
  ),
} as const;

export type ComputeNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

/** Local-disk only: no Management API, so no platform stack is built. */
const computeNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["compute", "new"]),
);

export const computeNewCommand = Command.make("new", config).pipe(
  Command.withDescription(
    "Scaffold a compute directory from a runtime's starter files and record the choices in supabase/config.toml. Nothing is deployed.",
  ),
  Command.withShortDescription("Scaffold a compute locally"),
  Command.withExamples([
    {
      command: "supabase compute new",
      description: "Prompt for the name, then for runtime, size and exposure",
    },
    {
      command: "supabase compute new api",
      description: "Scaffold supabase/compute/api, prompting for runtime, size and exposure",
    },
    {
      command: "supabase compute new api --runtime node",
      description: "Scaffold supabase/compute/api on the node runtime",
    },
    {
      command: "supabase compute new api --exposure private",
      description: "Scaffold a compute with no internet-facing URL",
    },
    {
      command: "supabase compute new api --instances 3",
      description: "Scaffold a compute that deploys at three instances",
    },
    {
      command: "supabase compute new api --source packages/api",
      description: "Scaffold the compute outside the compute directory",
    },
    {
      command: "supabase compute new api --template supabase-community/compute-starters/hono",
      description: "Bootstrap from a subdirectory of a GitHub repository",
    },
    {
      command: "supabase compute new api --template https://gitlab.com/acme/api.git#v2",
      description: "Bootstrap from any git repository, at a branch, tag or commit",
    },
  ]),
  Command.withHandler((flags) =>
    computeNew(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(computeNewRuntimeLayer),
);
