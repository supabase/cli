import { Argument, Command, Flag, Param } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { genTypes } from "./types.handler.ts";
import { genTypesRuntimeLayer } from "./types.layers.ts";

const LANG_VALUES = ["typescript", "go", "swift", "python"] as const;
const SWIFT_ACCESS_CONTROL_VALUES = ["internal", "public"] as const;

const config = {
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Generate types from the local dev database."),
    Flag.withDefault(false),
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Generate types from the linked project."),
    Flag.withDefault(false),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription("Generate types from a database url."),
    Flag.optional,
  ),
  projectId: Flag.String("project-id").pipe(
    Flag.withDescription("Generate types from a project ID."),
    Flag.optional,
  ),
  lang: Flag.Literals("lang", LANG_VALUES).pipe(
    Flag.withDescription("Output language of the generated types. (default typescript)"),
    Flag.withDefault("typescript"),
  ),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  swiftAccessControl: Flag.Literals("swift-access-control", SWIFT_ACCESS_CONTROL_VALUES).pipe(
    Flag.withDescription("Access control for Swift generated types. (default internal)"),
    Flag.withDefault("internal"),
  ),
  postgrestV9Compat: Flag.Boolean("postgrest-v9-compat").pipe(
    Flag.withDescription("Generate types compatible with PostgREST v9 and below."),
    Flag.withDefault(false),
  ),
  queryTimeout: Flag.String("query-timeout").pipe(
    Flag.withDescription("Maximum timeout allowed for the database query. (default 15s)"),
    Flag.withDefault("15s"),
  ),
} as const;

const commandConfig = {
  ...config,
  language: Argument.String("language").pipe(Argument.optional, Param.withHidden),
} as const;

export type GenTypesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const genTypesCommand = Command.make("types", commandConfig).pipe(
  Command.withDescription("Generate types from Postgres schema."),
  Command.withShortDescription("Generate types from Postgres schema"),
  Command.withExamples([
    {
      command: "supabase gen types --local",
      description: "Generate types from the local dev database",
    },
    {
      command: "supabase gen types --linked --lang=go",
      description: "Generate Go types from the linked project",
    },
    {
      command: "supabase gen types --project-id abc-def-123 --schema public --schema private",
      description: "Generate types from a project ID with specific schemas",
    },
    {
      command: "supabase gen types --db-url 'postgresql://...' --schema public --schema auth",
      description: "Generate types from a database URL",
    },
  ]),
  Command.withHandler((flags) =>
    genTypes(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-id"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(genTypesRuntimeLayer),
);
