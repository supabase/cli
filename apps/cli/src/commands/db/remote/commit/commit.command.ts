import { Command, Flag } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { removedCommand } from "../../../../command-internal/removed-command.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";

const config = {
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription("Connect using the specified Postgres URL (must be percent-encoded)."),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Connect to the linked project."),
    Flag.withDefault(false),
  ),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the linked project (--linked/--project-ref). Not used with --local or --db-url.",
  }),
} as const;

export const dbRemoteCommitCommand = Command.make("commit", config).pipe(
  Command.withDescription("Removed: use `supabase db pull` instead."),
  Command.withShortDescription("Removed: use `db pull` instead"),
  // Removed: fails before any Management API call, so no flag changes what it calls.
  withPermissions({
    operations: [],
    noApiEffectFlags: ["db-url", "linked", "password", "schema"],
  }),
  Command.withHandler(() =>
    removedCommand("Use `supabase db pull` instead.").pipe(
      withCommandTelemetry(),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["db", "remote", "commit"])),
  Command.provide(telemetryStateLayer),
  withCliConfigFlags(config),
);
