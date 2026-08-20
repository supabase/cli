import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsPush } from "./push.handler.ts";

const config = {
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription(
      "Skip confirmation prompts. Still checks target identity and live verify.",
    ),
    Flag.withAlias("y"),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Must match the linked project."),
    Flag.optional,
  ),
  allowRemote: Flag.boolean("allow-remote").pipe(
    Flag.withDescription("Required when pushing to a raw --db-url connection string."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Raw connection string. Requires --allow-remote."),
    Flag.optional,
  ),
  skipVerify: Flag.boolean("skip-verify").pipe(
    Flag.withDescription(
      "Skip checks that schemas and the remote still match the migration files.",
    ),
  ),
} as const;

export type LegacyMigrationsPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Apply pending migration files to the linked project.\n\n" +
      "This is the only CLI command that changes a remote schema.\n\n" +
      "Fails if supabase/schemas is ahead of the migration files, or if the remote has drifted.",
  ),
  Command.withShortDescription("Push pending migrations to the linked project"),
  Command.withExamples([
    {
      command: "supabase migrations push",
      description: "Apply pending files to the linked project",
    },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsPush(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config, aliases: { y: "yes" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "push"])),
);
