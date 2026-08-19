import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsPush } from "./push.handler.ts";

const flags = {
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Answer ordinary prompts. Never authorizes data loss."),
    Flag.withAlias("y"),
  ),
  allowDataLoss: Flag.boolean("allow-data-loss").pipe(
    Flag.withDescription("Required when pending migrations are destructive or unclassified."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Must match the resolved linked project for destructive non-interactive runs.",
    ),
    Flag.optional,
  ),
  allowRemote: Flag.boolean("allow-remote").pipe(
    Flag.withDescription("Acknowledge an unverifiable --db-url target."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Raw connection string. Requires --allow-remote for destructive plans."),
    Flag.optional,
  ),
} as const;

export type MigrationsPushFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const migrationsPushCommand = Command.make("push", flags).pipe(
  Command.withDescription(
    "Apply exact pending migration files to the linked platform database.\n\n" +
      "This is the only CLI path that mutates durable remote schema. " +
      "It fails closed when declarations are ahead of the migration head or remote drift is detected.",
  ),
  Command.withShortDescription("Push pending migrations to the platform"),
  Command.withHandler((commandFlags) =>
    migrationsPush(commandFlags).pipe(
      withCommandInstrumentation({ flags: commandFlags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "push"])),
);
