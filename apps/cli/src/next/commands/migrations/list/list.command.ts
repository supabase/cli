import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsList } from "./list.handler.ts";

const flags = {
  against: Flag.string("against").pipe(
    Flag.withDescription("Target to compare: local, linked, or a connection string."),
    Flag.optional,
  ),
} as const;

export type MigrationsListFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const migrationsListCommand = Command.make("list", flags).pipe(
  Command.withDescription("Compare local migration files with target migration history."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((commandFlags) =>
    migrationsList(commandFlags).pipe(
      withCommandInstrumentation({ flags: commandFlags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "list"])),
);
