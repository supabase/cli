import { Argument, Command, Flag, Param } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { genTypes } from "./types.handler.ts";
import { GEN_TYPES_LANGUAGES, genTypesLanguageFlags } from "./types.languages.ts";
import { genTypesRuntimeLayer } from "./types.layers.ts";

const config = {
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generate types from the local dev database."),
    Flag.withDefault(false),
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generate types from the linked project."),
    Flag.withDefault(false),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Generate types from a database url."),
    Flag.optional,
  ),
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Generate types from a project ID."),
    Flag.optional,
  ),
  lang: Flag.choice("lang", GEN_TYPES_LANGUAGES).pipe(
    Flag.withDescription("Output language of the generated types. (default typescript)"),
    Flag.withDefault("typescript"),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  // Hidden: Effect V4 has no `Flag.withDeprecated`; the handler prints cobra's deprecation line.
  postgrestV9Compat: Flag.boolean("postgrest-v9-compat").pipe(
    Flag.withDescription("Generate types compatible with PostgREST v9 and below."),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
  queryTimeout: Flag.string("query-timeout").pipe(
    Flag.withDescription("Maximum timeout allowed for the database query. (default 15s)"),
    Flag.withDefault("15s"),
  ),
} as const;

/** Long flag names (and the `-s` alias) `gen types` defines itself; registry flags may not reuse them. */
export const GEN_TYPES_CORE_FLAG_NAMES: ReadonlyArray<string> = [
  "local",
  "linked",
  "db-url",
  "project-id",
  "lang",
  "schema",
  "s",
  "postgrest-v9-compat",
  "query-timeout",
];

const flagsConfig = { ...config, ...genTypesLanguageFlags(GEN_TYPES_CORE_FLAG_NAMES) };

const commandConfig = {
  ...flagsConfig,
  language: Argument.string("language").pipe(Argument.optional, Param.withHidden),
} as const;

/** The registry's language flags are only known at runtime; read them through `languageOptionValues`. */
export type GenTypesFlags = CliCommand.Command.Config.Infer<typeof flagsConfig> &
  Readonly<Record<string, unknown>>;

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
      withCommandTelemetry({ flags, safeFlags: ["project-id"], config: flagsConfig }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(genTypesRuntimeLayer),
);
