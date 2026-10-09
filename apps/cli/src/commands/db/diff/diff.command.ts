import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbDiff } from "./diff.handler.ts";
import { dbDiffRuntimeLayer } from "./diff.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";

const config = {
  // The engine flags are a mutually-exclusive group, modelled as `Option` so the mutex check keys
  // off whether the flag was passed; engine selection uses its value.
  useMigra: Flag.boolean("use-migra").pipe(
    Flag.withDescription("Use migra to generate schema diff."),
    Flag.optional,
  ),
  usePgAdmin: Flag.boolean("use-pgadmin").pipe(
    Flag.withDescription("Use pgAdmin to generate schema diff."),
    Flag.optional,
  ),
  // Kept parsed (and hidden) only so using it produces an actionable removal error instead of
  // an unknown-flag parse error; see diff.handler.ts.
  usePgSchema: Flag.boolean("use-pg-schema").pipe(
    Flag.withDescription("Removed: use the default pg-delta engine or --use-migra instead."),
    Flag.optional,
    Flag.withHidden,
  ),
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Use pg-delta to generate schema diff.",
  }),
  strictCoverage: Flag.boolean("strict-coverage").pipe(
    Flag.withDescription(
      "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
    ),
    Flag.withDefault(false),
  ),
  from: Flag.string("from").pipe(
    Flag.withDescription("Diff from local, linked, migrations, or a Postgres URL."),
    Flag.optional,
  ),
  to: Flag.string("to").pipe(
    Flag.withDescription("Diff to local, linked, migrations, or a Postgres URL."),
    Flag.optional,
  ),
  output: Flag.string("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    ),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Diffs against the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  // The target flags form a mutually-exclusive group; modelled as `Option` so
  // the mutex check tracks whether a flag was passed. `--local` defaults to true
  // via the target resolver's fall-through.
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Diffs local migration files against the linked project."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Diffs local migration files against the local database."),
    Flag.optional,
  ),
  // Overrides the linked project ref; the same flag exists on `config push`.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      "In normal mode, names and saves the complete schema diff as a new migration; it does not filter objects. Ignored with --from/--to.",
    ),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // `--schema`/`-s` CSV-parses each value; use the shared helper so quoted
    // commas survive and malformed CSV fails at parse time.
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type DbDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription(
    "Compares a shadow built from supabase/migrations with a live database (--local by default, --linked, or --db-url). Declarative files under supabase/schemas are not part of this baseline. Output is printed by default; in normal mode, -f names and saves the complete diff as a migration and does not filter objects. Explicit --from/--to output is flattened review SQL, not a portable apply script.",
  ),
  Command.withShortDescription("Diffs the local database for schema changes"),
  Command.withHandler((flags) =>
    dbDiff(flags).pipe(
      withCommandTelemetry({
        flags: {
          "use-migra": flags.useMigra,
          "use-pgadmin": flags.usePgAdmin,
          "use-pg-schema": flags.usePgSchema,
          "use-pg-delta": flags.usePgDelta,
          "strict-coverage": flags.strictCoverage,
          from: flags.from,
          to: flags.to,
          output: flags.output,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          file: flags.file,
          schema: flags.schema,
        },
        // No established telemetry-safety baseline for --project-ref, so it stays redacted.
        aliases: { o: "output", f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbDiffRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
);
