import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../../../shared/output/json-error-handling.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { legacyAqua } from "../../../../../shared/legacy-colors.ts";
import { legacyParseSchemaFlags } from "../../../../../shared/legacy-schema-flags.ts";
import { withLegacyCommandInstrumentation } from "../../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { legacyDbSchemaDeclarativeGenerate } from "./generate.handler.ts";
import { legacyDbSchemaDeclarativeGenerateRuntimeLayer } from "./generate.layers.ts";

const config = {
  overwrite: Flag.boolean("overwrite").pipe(
    Flag.withDescription("Overwrite declarative schema files without confirmation."),
  ),
  output: Flag.string("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription(
      "Write the generated declarative schema to this directory without changing the configured declarative schema path.",
    ),
    Flag.optional,
  ),
  reset: Flag.boolean("reset").pipe(
    Flag.withDescription("Reset local database before generating (local data will be lost)."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // Go registers `--schema` as a cobra `StringSliceVarP`
    // (`apps/cli-go/cmd/db_schema_declarative.go:495`, deleted in CLI-1970;
    // last present at commit 7b469f5b3), which CSV-splits each
    // occurrence so `-s public,auth` includes the two schemas separately. Mirror
    // the `gen types` / `db lint` parsing so quoted commas are handled the same way.
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Generates declarative schema from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  // Go gates explicit-target selection on `flag.Changed` (presence), not the bool
  // value — `hasExplicitTargetFlag` is `Changed("local")||Changed("linked")||
  // Changed("db-url")` (`apps/cli-go/cmd/db_schema_declarative.go:139-141`,
  // deleted in CLI-1970; last present at commit 7b469f5b3). Model
  // `--linked`/`--local` as `Option` (like `--db-url`) so `--linked=false` still
  // takes the explicit linked path, matching Go (and the `db query` fix).
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generates declarative schema from the linked project."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generates declarative schema from the local database."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type LegacyDbSchemaDeclarativeGenerateFlags = CliCommand.Command.Config.Infer<
  typeof config
> & { readonly noCache: boolean; readonly strictCoverage: boolean };

export const legacyDbSchemaDeclarativeGenerateCommand = Command.make("generate", config).pipe(
  Command.withDescription(
    "Exports a live database into the complete declarative schema tree. This replaces declarative files only; it does not create migration files or update migration history. Use --output to stage an export without changing the configured declarative path. In non-interactive use, pass --local, --linked, or --db-url explicitly.",
  ),
  Command.withShortDescription("Generate declarative schema from a database"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // `--no-cache` is shared on the parent group; read the resolved value there.
      const shared = yield* legacyDbSchemaDeclarativeSharedBase;
      const merged: LegacyDbSchemaDeclarativeGenerateFlags = {
        ...flags,
        noCache: shared.noCache,
        strictCoverage: shared.strictCoverage,
      };
      return yield* legacyDbSchemaDeclarativeGenerate(merged).pipe(
        // Go's PostRun prints this on success via `fmt.Println` → stdout
        // (`cmd/db_schema_declarative.go:93`), so keep it on stdout in text mode. In
        // json / stream-json the bare human line would corrupt the payload, so emit a
        // structured result instead (machine stdout is payload-only — CLI-1546).
        Effect.tap(() =>
          Effect.gen(function* () {
            const output = yield* Output;
            if (output.format === "text") {
              yield* output.raw(
                `Finished ${legacyAqua("supabase db schema declarative generate")}.\n`,
              );
              return;
            }
            yield* output.success("Finished supabase db schema declarative generate.");
          }),
        ),
        withLegacyCommandInstrumentation({
          flags: {
            "no-cache": merged.noCache,
            "strict-coverage": merged.strictCoverage,
            overwrite: merged.overwrite,
            output: merged.output,
            reset: merged.reset,
            schema: merged.schema,
            "db-url": merged.dbUrl,
            linked: merged.linked,
            local: merged.local,
            // `password` must never be added to `safeFlags` — it is a credential and
            // must always reach telemetry as `<redacted>` (matches Go, which never
            // marks `--password` telemetry-safe).
            password: merged.password,
          },
          // Go registers `--schema`/`-s` (StringSliceVarP) and `--password`/`-p`
          // (StringVarP) (`cmd/db_schema_declarative.go:495,500`); telemetry reports
          // changed flags by canonical `flag.Name` via `pflag.Visit`, so map the
          // shorthands so `generate -s public -p secret` logs `schema`/`password`.
          aliases: { o: "output", s: "schema", p: "password" },
        }),
        withJsonErrorHandling,
      );
    }),
  ),
  Command.provide(legacyDbSchemaDeclarativeGenerateRuntimeLayer),
);
