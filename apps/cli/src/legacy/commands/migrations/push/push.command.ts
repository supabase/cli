import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsPush } from "./push.handler.ts";

const config = {
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription(
      "Skip the dirty first-push catalog confirm. Still type the project ref unless --project-ref is set. Live verify still runs.",
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
      "This is the only CLI command that changes a remote schema. It prints the pending files, then asks you to type the project ref (even with --yes). --yes skips only the dirty-catalog confirm.\n\n" +
      "Live-verify must pass unless --skip-verify. Remote-only versions: migrations pull. Histories aligned but catalog differs: privilege offer, or migrations diff --against linked then migration repair --status applied.",
  ),
  Command.withShortDescription("Push pending migrations to the linked project"),
  Command.withExamples([
    {
      command: "supabase migrations push",
      description: "Preview pending files, confirm the project ref, then apply",
    },
    {
      command: "supabase migrations push --yes --project-ref <ref>",
      description: "Skip the ref prompt by asserting the linked project",
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
