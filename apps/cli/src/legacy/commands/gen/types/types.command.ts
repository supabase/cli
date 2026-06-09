import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyGenTypes } from "./types.handler.ts";

const LANG_VALUES = ["typescript", "go", "swift", "python"] as const;
const SWIFT_ACCESS_CONTROL_VALUES = ["internal", "public"] as const;

const config = {
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generate types from the local dev database."),
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generate types from the linked project."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Generate types from a database url."),
    Flag.optional,
  ),
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Generate types from a project ID."),
    Flag.optional,
  ),
  lang: Flag.choice("lang", LANG_VALUES).pipe(
    Flag.withDescription("Output language of the generated types. (default typescript)"),
    Flag.withDefault("typescript"),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  swiftAccessControl: Flag.choice("swift-access-control", SWIFT_ACCESS_CONTROL_VALUES).pipe(
    Flag.withDescription("Access control for Swift generated types. (default internal)"),
    Flag.withDefault("internal"),
  ),
  postgrestV9Compat: Flag.boolean("postgrest-v9-compat").pipe(
    Flag.withDescription("Generate types compatible with PostgREST v9 and below."),
  ),
  queryTimeout: Flag.string("query-timeout").pipe(
    Flag.withDescription("Maximum timeout allowed for the database query. (default 15s)"),
    Flag.withDefault("15s"),
  ),
} as const;

export type LegacyGenTypesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyGenTypesCommand = Command.make("types", config).pipe(
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
    legacyGenTypes(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-id"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["gen", "types"])),
);
