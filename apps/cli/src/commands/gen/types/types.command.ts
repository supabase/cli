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
  // Every language `@supabase/typegen` registers; a bump of that dependency can add one.
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
  // Deprecated: PostgREST 9 reached end of life in 2023 and the registry no longer exposes a
  // compatibility switch; the flag still turns one-to-one relationship detection off. Hidden
  // because Effect V4 has no `Flag.withDeprecated`; the handler prints cobra's deprecation line.
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

// Language flags (`--swift-access-control` today) come from the registry's user-facing option
// specs, keyed by flag name, so a new language's flags arrive with the dependency bump.
const flagsConfig = { ...config, ...genTypesLanguageFlags };

const commandConfig = {
  ...flagsConfig,
  language: Argument.string("language").pipe(Argument.optional, Param.withHidden),
} as const;

/**
 * The registry's language flags are only known at runtime, so they appear here as an index
 * signature; read them through `languageOptionValues` rather than by name.
 */
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
