import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsPull } from "./pull.handler.ts";

const config = {
  from: Flag.string("from").pipe(
    Flag.withDescription("Remote database. Defaults to linked. Also accepts a connection string."),
    Flag.withDefault("linked"),
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the pulled migration file."),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationsPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Record remote-only schema as local migration files.\n\n" +
      "Defaults to the linked project. Does not read supabase/schemas.\n\n" +
      "After writing files, mark those versions applied on the remote with migration repair so they are not re-run.",
  ),
  Command.withShortDescription("Record remote drift as migration files"),
  Command.withExamples([
    { command: "supabase migrations pull", description: "Record linked-project drift as files" },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsPull(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "pull"])),
);
