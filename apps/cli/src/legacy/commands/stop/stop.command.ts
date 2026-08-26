import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { legacyCliSettingsLayer } from "../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyStop } from "./stop.handler.ts";

const config = {
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Local project ID to stop."),
    Flag.optional,
  ),
  // Hidden boolean kept for backward compatibility: `--backup=false` is the historical
  // way to skip the backup and is functionally identical to `--no-backup`.
  backup: Flag.boolean("backup").pipe(
    Flag.withDescription("Backs up the current database before stopping."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Deletes all data volumes after stopping."),
    Flag.withDefault(false),
  ),
  // Modelled as `Option<boolean>` (presence = "explicitly set"), not a plain
  // boolean: `--project-id`/`--all` are mutually exclusive whenever BOTH flags
  // were explicitly set, regardless of the value `--all` was set to.
  // A plain `Flag.boolean` here would make `--project-id x --all=false`
  // indistinguishable from `--project-id x` (no `--all` at all), silently
  // accepting a combination that must be rejected.
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Stop all local Supabase instances from all projects across the machine."),
    Flag.optional,
  ),
} as const;

export type LegacyStopFlags = CliCommand.Command.Config.Infer<typeof config>;

// `stop` makes no Management API calls (it needs no access token) and talks
// directly to Docker, so it deliberately avoids `legacyManagementApiRuntimeLayer` —
// it provides only the services the handler + instrumentation consume.
// `ChildProcessSpawner` is not listed here: it comes from `BunServices` in the root
// runtime (`shared/cli/run.ts`), the same way `gen types`/`unlink` rely on it.
const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacyStopRuntimeLayer = Layer.mergeAll(
  cliSettings,
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
