import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../../../shared/output/json-error-handling.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { legacyAqua } from "../../../../../shared/legacy-colors.ts";
import { withLegacyCommandInstrumentation } from "../../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbSchemaDeclarativeGenerate } from "./generate.handler.ts";
import { legacyDbSchemaDeclarativeGenerateRuntimeLayer } from "./generate.layers.ts";

const config = {
  noCache: Flag.boolean("no-cache").pipe(
    Flag.withDescription("Disable catalog cache and force fresh shadow database setup."),
  ),
  overwrite: Flag.boolean("overwrite").pipe(
    Flag.withDescription("Overwrite declarative schema files without confirmation."),
  ),
  reset: Flag.boolean("reset").pipe(
    Flag.withDescription("Reset local database before generating (local data will be lost)."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Generates declarative schema from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generates declarative schema from the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generates declarative schema from the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbSchemaDeclarativeGenerateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbSchemaDeclarativeGenerateCommand = Command.make("generate", config).pipe(
  Command.withDescription("Generate declarative schema from a database."),
  Command.withShortDescription("Generate declarative schema from a database"),
  Command.withHandler((flags) =>
    legacyDbSchemaDeclarativeGenerate(flags).pipe(
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
          "no-cache": flags.noCache,
          overwrite: flags.overwrite,
          reset: flags.reset,
          schema: flags.schema,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` must never be added to `safeFlags` — it is a credential and
          // must always reach telemetry as `<redacted>` (matches Go, which never
          // marks `--password` telemetry-safe).
          password: flags.password,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbSchemaDeclarativeGenerateRuntimeLayer),
);
