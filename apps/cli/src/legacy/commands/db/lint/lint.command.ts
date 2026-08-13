import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyParseSchemaFlags } from "../../../shared/legacy-schema-flags.ts";
import { legacyDbLint } from "./lint.handler.ts";
import { legacyDbLintRuntimeLayer } from "./lint.layers.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Lints the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Lints the linked project for schema errors."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Lints the local database for schema errors."),
  ),
  // TS-only override of the linked project ref — see push.command.ts.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
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
  level: Flag.choice("level", ["warning", "error"] as const).pipe(
    Flag.withDescription("Error level to emit."),
    Flag.optional,
  ),
  failOn: Flag.choice("fail-on", ["none", "warning", "error"] as const).pipe(
    Flag.withDescription("Error level to exit with non-zero status."),
    Flag.optional,
  ),
} as const;

export type LegacyDbLintFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbLintCommand = Command.make("lint", config).pipe(
  Command.withDescription("Checks local database for typing error."),
  Command.withShortDescription("Checks local database for typing error"),
  Command.withHandler((flags) =>
    legacyDbLint(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          schema: flags.schema,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // level/fail-on are Flag.choice and are auto-detected as safe via
        // `config` below (Go's isEnumFlag, cmd/root_analytics.go:110-116).
        // --schema stays redacted: it's a []string slice flag in Go, not an EnumFlag.
        // --project-ref is a TS-only flag with no Go telemetry-safety baseline
        // either; Go's nearest --project-ref registrations
        // (cmd/pgdelta_catalog.go:44 and most others) are unmarked, so it stays
        // redacted too.
        config,
        // Go's changedFlags() uses pflag Visit, which reports the canonical
        // `schema` name even for the `-s` shorthand (cmd/db.go:506); map it so
        // `db lint -s public` records the schema flag in telemetry.
        aliases: { s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbLintRuntimeLayer),
);
