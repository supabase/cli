import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { dbLint } from "./lint.handler.ts";
import { dbLintRuntimeLayer } from "./lint.layers.ts";

const config = {
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Lints the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Lints the linked project for schema errors."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Lints the local database for schema errors."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
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
  level: Flag.Literals("level", ["warning", "error"] as const).pipe(
    Flag.withDescription("Error level to emit."),
    Flag.optional,
  ),
  failOn: Flag.Literals("fail-on", ["none", "warning", "error"] as const).pipe(
    Flag.withDescription("Error level to exit with non-zero status."),
    Flag.optional,
  ),
} as const;

export type DbLintFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbLintCommand = Command.make("lint", config).pipe(
  Command.withDescription("Checks local database for typing error."),
  Command.withShortDescription("Checks local database for typing error"),
  Command.withHandler((flags) =>
    dbLint(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          schema: flags.schema,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // level/fail-on are auto-detected as safe (Flag.Literals); --schema and
        // --project-ref stay redacted (no established safelist).
        config,
        aliases: { s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbLintRuntimeLayer),
);
