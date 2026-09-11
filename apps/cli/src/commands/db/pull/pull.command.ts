import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbPull } from "./pull.handler.ts";
import { dbPullRuntimeLayer } from "./pull.layers.ts";

const config = {
  name: Argument.String("migration name").pipe(
    Argument.withDescription("Optional name for the migration file."),
    Argument.optional,
  ),
  // `--declarative` and the deprecated `--use-pg-delta` both select declarative
  // export and are mutually exclusive with `--diff-engine`. Optional so the
  // mutex tracks whether the flag was passed.
  declarative: Flag.Boolean("declarative").pipe(
    Flag.withDescription(
      "Replace the declarative schema tree from the selected database instead of creating a migration; migration history is not updated.",
    ),
    Flag.optional,
  ),
  usePgDelta: Flag.Boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to pull declarative schema."),
    // Hidden: Effect V4 has no `Flag.withDeprecated`; the handler prints
    // cobra's deprecation line.
    Flag.withHidden,
    Flag.optional,
  ),
  diffEngine: Flag.Literals("diff-engine", ["migra", "pg-delta"] as const).pipe(
    Flag.withDescription("Diff engine to use for migration-style db pull."),
    Flag.optional,
  ),
  strictCoverage: Flag.Boolean("strict-coverage").pipe(
    Flag.withDescription(
      "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
    ),
    Flag.withDefault(false),
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
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Pulls from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Pulls from the linked project."),
    Flag.optional,
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Pulls from the local database."),
    Flag.optional,
  ),
  // TS-only override of the linked project ref — see push.command.ts.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  password: Flag.String("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type DbPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Migration mode compares supabase/migrations with the selected live database (--linked by default), writes the complete difference as migration files, and may record them in that database's migration history. --declarative instead replaces the declarative schema tree and does not create migrations or update migration history.",
  ),
  Command.withShortDescription("Pull schema from the remote database"),
  Command.withHandler((flags) =>
    dbPull(flags).pipe(
      withCommandTelemetry({
        flags: {
          declarative: flags.declarative,
          "use-pg-delta": flags.usePgDelta,
          "diff-engine": flags.diffEngine,
          "strict-coverage": flags.strictCoverage,
          schema: flags.schema,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // Not on the established `--project-ref` safeFlags allowlist, so it stays redacted.
        aliases: { s: "schema", p: "password" },
        config,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbPullRuntimeLayer),
);
