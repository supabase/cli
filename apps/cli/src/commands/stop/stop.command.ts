import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { stop } from "./stop.handler.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  projectId: cliFlag("project-id", Flag.String, {
    description: "Local project ID to stop.",
    optional: true,
  }),
  // Hidden for backward compatibility: `--backup=false` is equivalent to `--no-backup`.
  backup: cliFlag("backup", Flag.Boolean, {
    description: "Back up the current database before stopping.",
    default: true,
    hidden: true,
  }),
  noBackup: cliFlag("no-backup", Flag.Boolean, {
    description: "Delete all data volumes after stopping.",
    default: false,
  }),
  // `Option<boolean>` so presence means "explicitly set": `--project-id`/`--all` are mutually
  // exclusive whenever both were explicitly set, regardless of `--all`'s value. A plain
  // `Flag.Boolean` couldn't distinguish `--project-id x --all=false` from `--project-id x` alone.
  all: cliFlag("all", Flag.Boolean, {
    description: "Stop the local Supabase stacks of every project on this machine.",
    optional: true,
  }),
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

export const stopCommand = makeCommand("stop", config).pipe(
  Command.withDescription("Stop the Supabase local development stack and its containers."),
  Command.withShortDescription("Stop the local Supabase stack"),
  withPermissions({
    operations: [],
    noApiEffectFlags: ["project-id", "backup", "no-backup", "all"],
  }),
  Command.withHandler((flags) =>
    stop(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(stopRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
