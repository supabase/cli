import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyParseSchemaFlags } from "../../../shared/legacy-schema-flags.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbDiff } from "./diff.handler.ts";
import { legacyDbDiffRuntimeLayer } from "./diff.layers.ts";

const config = {
  // The four engine flags form a cobra mutually-exclusive group
  // (`apps/cli-go/cmd/db.go:416`) and `--use-migra` defaults to true, so they are
  // modelled as `Option` to track pflag `Changed`: the mutex check and
  // `resolveDiffEngine`'s `useMigraChanged` key off whether the flag was passed,
  // not its value.
  useMigra: Flag.boolean("use-migra").pipe(
    Flag.withDescription("Use migra to generate schema diff."),
    Flag.optional,
  ),
  usePgAdmin: Flag.boolean("use-pgadmin").pipe(
    Flag.withDescription("Use pgAdmin to generate schema diff."),
    Flag.optional,
  ),
  usePgSchema: Flag.boolean("use-pg-schema").pipe(
    // CLI-1960: deprecated in favor of the pg-delta engine (or the default
    // migra engine); a keep-in-Go exception (in-process stripe/pg-schema-diff
    // library, no TS/container equivalent — see SIDE_EFFECTS.md), not a pending
    // port. The flag itself is not marked deprecated in Go (no `MarkDeprecated`
    // upstream), so this description-only notice is TS-only — see
    // diff.handler.ts's runtime warning for the enforced half of the deprecation.
    Flag.withDescription(
      "Use pg-schema-diff to generate schema diff. Deprecated: use the pg-delta engine ([experimental.pgdelta] enabled = true / --use-pg-delta) or the default migra engine instead.",
    ),
    Flag.optional,
  ),
  usePgDelta: Flag.boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to generate schema diff."),
    Flag.optional,
  ),
  strictCoverage: Flag.boolean("strict-coverage").pipe(
    Flag.withDescription(
      "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
    ),
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
    Flag.withDescription("Write explicit diff output to a file path."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Diffs against the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  // The target flags form the cobra group `[db-url linked local]`
  // (`apps/cli-go/cmd/db.go:423`); modelled as `Option` so the mutex check tracks
  // `Changed`. `--local` defaults to true via the target resolver's fall-through.
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Diffs local migration files against the linked project."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Diffs local migration files against the local database."),
    Flag.optional,
  ),
  // TS-only override of the linked project ref — see push.command.ts.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      "Names and saves the complete schema diff as a new migration; it does not filter objects.",
    ),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // Go registers --schema/-s as a cobra StringSliceVarP (`apps/cli-go/cmd/db.go:425`),
    // CSV-parsing each value; use the shared pflag-faithful helper so quoted commas
    // survive and malformed CSV fails at parse time.
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type LegacyDbDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription(
    "Compares a shadow built from supabase/migrations with a live database (--local by default, --linked, or --db-url). Declarative files under supabase/database are not part of this baseline. Output is printed by default; -f names and saves the complete diff as a migration and does not filter objects.",
  ),
  Command.withShortDescription("Diffs the local database for schema changes"),
  Command.withHandler((flags) =>
    legacyDbDiff(flags).pipe(
      withLegacyCommandInstrumentation({
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
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
        aliases: { o: "output", f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbDiffRuntimeLayer),
);
