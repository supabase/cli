import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacySchemaPull } from "./pull.handler.ts";

const config = {
  from: Flag.string("from").pipe(
    Flag.withDescription(
      "Source database. Defaults to local. Also accepts linked or a connection string.",
    ),
    Flag.withDefault("local"),
  ),
  output: Flag.string("output").pipe(
    Flag.withDescription("Write a side-by-side snapshot instead of replacing supabase/schemas."),
    Flag.optional,
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription(
      "Replace managed files in supabase/schemas. Not a merge. _custom/ is left alone.",
    ),
  ),
  pruneUnmanaged: Flag.boolean("prune-unmanaged").pipe(
    Flag.withDescription(
      "Delete unmanaged .sql files that are not owned by the export or _custom/.",
    ),
  ),
} as const;

export type LegacySchemaPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySchemaPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Write supabase/schemas from a live database.\n\n" +
      "Defaults to the local database. Use --from linked or a connection string to pull a remote instead.\n\n" +
      "The database wins: pull replaces managed files and never merges. Files in _custom/ are left alone.\n\n" +
      "If supabase/schemas already exists, pass --force to replace it, or --output <dir> for a side-by-side copy.",
  ),
  Command.withShortDescription("Write supabase/schemas from a database"),
  Command.withExamples([
    { command: "supabase schema pull", description: "Export the local database" },
    {
      command: "supabase schema pull --from linked",
      description: "Export the linked project database",
    },
    {
      command: "supabase schema pull --from linked --output supabase/schemas.remote",
      description: "Write a side-by-side remote snapshot",
    },
    {
      command: "supabase schema pull --force",
      description: "Replace the managed schema tree from local",
    },
  ]),
  Command.withHandler((flags) =>
    legacySchemaPull(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["schema", "pull"])),
);
