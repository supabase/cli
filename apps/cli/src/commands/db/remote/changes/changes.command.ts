import { Command, Flag } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { removedCommand } from "../../../../command-internal/removed-command.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../../shared/cli/cli-params.ts";

const config = {
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
  }),
  dbUrl: cliFlag("db-url", Flag.String, {
    description: "Connect using the specified Postgres URL (must be percent-encoded).",
    optional: true,
  }),
  linked: cliFlag("linked", Flag.Boolean, {
    description: "Connect to the linked project.",
    default: false,
  }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

export const dbRemoteChangesCommand = makeCommand("changes", config).pipe(
  Command.withDescription("Removed: use `supabase db diff --remote` instead."),
  Command.withShortDescription("Removed: use `db diff --remote` instead"),
  // Removed: fails before any Management API call, so no flag changes what it calls.
  withPermissions({
    operations: [],
    noApiEffectFlags: ["db-url", "linked", "password", "schema"],
  }),
  Command.withHandler(() =>
    removedCommand("Use `supabase db diff --remote` instead.").pipe(
      withCommandTelemetry(),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["db", "remote", "changes"])),
  Command.provide(telemetryStateLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "removed", consent: "none" }),
);
