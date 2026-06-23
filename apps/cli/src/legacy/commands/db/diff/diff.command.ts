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
    Flag.withDescription("Use pg-schema-diff to generate schema diff."),
    Flag.optional,
  ),
  usePgDelta: Flag.boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to generate schema diff."),
    Flag.optional,
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
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves schema diff to a new migration file."),
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
  Command.withDescription("Diffs the local database for schema changes."),
  Command.withShortDescription("Diffs the local database for schema changes"),
  Command.withHandler((flags) =>
    legacyDbDiff(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "use-migra": flags.useMigra,
          "use-pgadmin": flags.usePgAdmin,
          "use-pg-schema": flags.usePgSchema,
          "use-pg-delta": flags.usePgDelta,
          from: flags.from,
          to: flags.to,
          output: flags.output,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          file: flags.file,
          schema: flags.schema,
        },
        aliases: { o: "output", f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbDiffRuntimeLayer),
);
