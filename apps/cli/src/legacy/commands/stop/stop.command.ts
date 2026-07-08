import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyStop } from "./stop.handler.ts";

const config = {
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Local project ID to stop."),
    Flag.optional,
  ),
  // Hidden boolean kept for Go CLI parity: `--backup=false` is the historical
  // way to skip the backup and is functionally identical to `--no-backup`.
  backup: Flag.boolean("backup").pipe(
    Flag.withDescription("Backs up the current database before stopping."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Deletes all data volumes after stopping."),
  ),
  // Modelled as `Option<boolean>` (presence = pflag `Changed`), not a plain
  // boolean: Cobra's `MarkFlagsMutuallyExclusive("project-id", "all")`
  // (`apps/cli-go/cmd/stop.go:31`) rejects the command whenever BOTH flags
  // were explicitly set, regardless of the value `--all` was set to — the
  // vendored cobra@v1.10.2 `flag_groups.go:139` check is
  // `groupStatus[group][name] = flag.Changed`, not the flag's boolean value.
  // A plain `Flag.boolean` here would make `--project-id x --all=false`
  // indistinguishable from `--project-id x` (no `--all` at all), silently
  // accepting a combination Go rejects.
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Stop all local Supabase instances from all projects across the machine."),
    Flag.optional,
  ),
} as const;

export type LegacyStopFlags = CliCommand.Command.Config.Infer<typeof config>;

// `stop` makes no Management API calls (Go's stop needs no access token) and talks
// directly to Docker, so it deliberately avoids `legacyManagementApiRuntimeLayer` —
// it provides only the services the handler + instrumentation consume.
// `ChildProcessSpawner` is not listed here: it comes from `BunServices` in the root
// runtime (`shared/cli/run.ts`), the same way `gen types`/`unlink` rely on it.
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacyStopRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["stop"]),
);

export const legacyStopCommand = Command.make("stop", config).pipe(
  Command.withDescription("Stop all local Supabase containers."),
  Command.withShortDescription("Stop all local Supabase containers"),
  Command.withHandler((flags) =>
    legacyStop(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyStopRuntimeLayer),
);
