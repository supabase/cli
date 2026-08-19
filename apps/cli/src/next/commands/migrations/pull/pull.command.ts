import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsPull } from "./pull.handler.ts";

const flags = {
  from: Flag.string("from").pipe(
    Flag.withDescription("Remote database: linked or a connection string."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the pulled migration file."),
    Flag.optional,
  ),
} as const;

export type MigrationsPullFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const migrationsPullCommand = Command.make("pull", flags).pipe(
  Command.withDescription(
    "Record remote-only database state as local migration files.\n\n" +
      "Does not interpret declarative SQL.",
  ),
  Command.withShortDescription("Pull remote schema drift into migrations"),
  Command.withHandler((commandFlags) =>
    migrationsPull(commandFlags).pipe(
      withCommandInstrumentation({ flags: commandFlags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "pull"])),
);
