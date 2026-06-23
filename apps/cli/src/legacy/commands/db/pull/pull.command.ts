import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyParseSchemaFlags } from "../../../shared/legacy-schema-flags.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbPull } from "./pull.handler.ts";
import { legacyDbPullRuntimeLayer } from "./pull.layers.ts";

const config = {
  name: Argument.string("migration name").pipe(
    Argument.withDescription("Optional name for the migration file."),
    Argument.optional,
  ),
  // `--declarative` and the deprecated `--use-pg-delta` both bind to the same
  // declarative-output mode in Go (`cmd/db.go:464-465`); both are mutually
  // exclusive with `--diff-engine`. Modelled as `Option` so the mutex tracks
  // pflag `Changed`.
  declarative: Flag.boolean("declarative").pipe(
    Flag.withDescription(
      "Pull schema as declarative files using pg-delta instead of creating a migration.",
    ),
    Flag.optional,
  ),
  usePgDelta: Flag.boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to pull declarative schema."),
    // Go marks this deprecated (`cmd/db.go:466`); Effect V4 has no
    // `Flag.withDeprecated`, so it is hidden and the handler emits the
    // deprecation line to stderr, matching cobra's behaviour.
    Flag.withHidden,
    Flag.optional,
  ),
  diffEngine: Flag.choice("diff-engine", ["migra", "pg-delta"] as const).pipe(
    Flag.withDescription("Diff engine to use for migration-style db pull."),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Pulls from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Pulls from the linked project."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Pulls from the local database."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbPullCommand = Command.make("pull", config).pipe(
  Command.withDescription("Pull schema from the remote database."),
  Command.withShortDescription("Pull schema from the remote database"),
  Command.withHandler((flags) =>
    legacyDbPull(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          declarative: flags.declarative,
          "use-pg-delta": flags.usePgDelta,
          "diff-engine": flags.diffEngine,
          schema: flags.schema,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        aliases: { s: "schema", p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbPullRuntimeLayer),
);
