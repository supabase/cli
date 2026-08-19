import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import {
  SCHEMA_ECOSYSTEM_MAPPING_HELP,
  SCHEMA_PULL_NO_MERGE_HELP,
} from "../../../../shared/schema/schema-ecosystem.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacySchemaPull } from "./pull.handler.ts";

const config = {
  from: Flag.string("from").pipe(
    Flag.withDescription("Source database: local, linked, or a connection string."),
    Flag.optional,
  ),
  output: Flag.string("output").pipe(
    Flag.withDescription("Write a side-by-side snapshot instead of replacing supabase/schemas."),
    Flag.optional,
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Replace the complete managed declaration tree. This is not a merge."),
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
    "Introspect a database into declarative SQL files.\n\n" +
      "The database is authoritative. Pull regenerates managed files and never merges SQL. " +
      "_custom/ is never modified.\n\n" +
      `${SCHEMA_PULL_NO_MERGE_HELP}\n\n${SCHEMA_ECOSYSTEM_MAPPING_HELP}`,
  ),
  Command.withShortDescription("Pull a database into supabase/schemas"),
  Command.withExamples([
    { command: "supabase schema pull --from local", description: "Export the local database" },
    {
      command: "supabase schema pull --from linked",
      description: "Export the linked project database",
    },
    {
      command: "supabase schema pull --from linked --output supabase/schemas.remote",
      description: "Write a side-by-side remote snapshot",
    },
    {
      command: "supabase schema pull --from linked --force",
      description: "Replace the managed schema tree",
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
