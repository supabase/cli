import { Command, Flag } from "effect/unstable/cli";
import { removedCommand } from "../../../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";

const config = {
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Connect using the specified Postgres URL (must be percent-encoded)."),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Connect to the linked project."),
    Flag.withDefault(false),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export const dbRemoteChangesCommand = Command.make("changes", config).pipe(
  Command.withDescription("Removed: use `supabase db diff --linked` instead."),
  Command.withShortDescription("Removed: use `db diff --linked` instead"),
  Command.withHandler(() =>
    removedCommand("Use `supabase db diff --linked` instead.").pipe(
      withCommandTelemetry(),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["db", "remote", "changes"])),
);
