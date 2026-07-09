import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyParseSchemaFlags } from "../../../shared/legacy-schema-flags.ts";
import { legacyGenTanstackDb } from "./tanstack-db.handler.ts";
import { legacyGenTanstackDbRuntimeLayer } from "./tanstack-db.layers.ts";

const config = {
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generate the TanStack DB file from the local dev database."),
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generate the TanStack DB file from the linked project."),
  ),
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Generate the TanStack DB file from a project ID."),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type LegacyGenTanstackDbFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyGenTanstackDbCommand = Command.make("tanstack-db", config).pipe(
  Command.withDescription(
    "Generate a Zod + TanStack DB collection file from your Postgres schema.",
  ),
  Command.withShortDescription("Generate a TanStack DB file from your Postgres schema"),
  Command.withExamples([
    {
      command: "supabase gen tanstack-db --local",
      description: "Generate a TanStack DB file from the local dev database",
    },
    {
      command: "supabase gen tanstack-db --linked --schema public --schema private",
      description: "Generate a TanStack DB file from the linked project with specific schemas",
    },
    {
      command: "supabase gen tanstack-db --project-id abc-def-123",
      description: "Generate a TanStack DB file from a project ID",
    },
  ]),
  Command.withHandler((flags) =>
    legacyGenTanstackDb(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-id"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyGenTanstackDbRuntimeLayer),
);
