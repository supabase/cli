import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { stop } from "./stop.handler.ts";

const config = {
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Local project ID to stop."),
    Flag.optional,
  ),
  // Hidden for backward compatibility: `--backup=false` is equivalent to `--no-backup`.
  backup: Flag.boolean("backup").pipe(
    Flag.withDescription("Backs up the current database before stopping."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Deletes all data volumes after stopping."),
    Flag.withDefault(false),
  ),
  // `Option<boolean>` so presence means "explicitly set": `--project-id`/`--all` are mutually
  // exclusive whenever both were explicitly set, regardless of `--all`'s value. A plain
  // `Flag.boolean` couldn't distinguish `--project-id x --all=false` from `--project-id x` alone.
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Stop all local Supabase instances from all projects across the machine."),
    Flag.optional,
  ),
} as const;

export type StopFlags = CliCommand.Command.Config.Infer<typeof config>;

// `stop` talks directly to Docker and needs no Management API access, so it provides only
// the services the handler and instrumentation consume, not `managementApiRuntimeLayer`.
// `ChildProcessSpawner` comes from `BunServices` in the root runtime instead.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const stopRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["stop"]),
);

export const stopCommand = Command.make("stop", config).pipe(
  Command.withDescription("Stop all local Supabase containers."),
  Command.withShortDescription("Stop all local Supabase containers"),
  Command.withHandler((flags) =>
    stop(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(stopRuntimeLayer),
);
