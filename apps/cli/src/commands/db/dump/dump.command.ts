import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { DbDumpRunError } from "./dump.errors.ts";
import { dbDump } from "./dump.handler.ts";
import { dbDumpRuntimeLayer } from "./dump.layers.ts";

/**
 * `db dump` has no `--output-format` machine envelope; it streams pg_dump SQL to
 * stdout (or `--file`) in every mode. A run failure (nonzero container exit) sends the
 * diagnostic to stderr and exits 1 in json/stream-json mode instead of letting
 * `withJsonErrorHandling` corrupt already-written SQL with a JSON error object.
 */
const onRunFailure = (error: DbDumpRunError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* Effect.fail(error);
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

const config = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Prints the pg_dump script that would be executed."),
    Flag.withDefault(false),
  ),
  // Mutually-exclusive-group flags (data-only/role-only/keep-comments, and the
  // db-url/linked/local target group) are modelled as `Option` so presence, not
  // value, drives validation — `--data-only=false` still counts as set.
  dataOnly: Flag.Boolean("data-only").pipe(
    Flag.withDescription("Dumps only data records."),
    Flag.optional,
  ),
  useCopy: Flag.Boolean("use-copy").pipe(
    Flag.withDescription("Use copy statements in place of inserts."),
    Flag.withDefault(false),
  ),
  exclude: Flag.String("exclude").pipe(
    Flag.withAlias("x"),
    Flag.withDescription("List of schema.tables to exclude from data-only dump."),
    Flag.atLeast(0),
    // CSV string-slice value; quoted commas survive, malformed CSV fails at parse time.
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  roleOnly: Flag.Boolean("role-only").pipe(
    Flag.withDescription("Dumps only cluster roles."),
    Flag.optional,
  ),
  keepComments: Flag.Boolean("keep-comments").pipe(
    Flag.withDescription("Keeps commented lines from pg_dump output."),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("File path to save the dumped contents."),
    Flag.optional,
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Dumps from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Dumps from the linked project."),
    Flag.optional,
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Dumps from the local database."),
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
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // --schema/-s is a CSV string-slice value; same CSV semantics as --exclude above.
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type DbDumpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbDumpCommand = Command.make("dump", config).pipe(
  Command.withDescription("Dumps data or schemas from the remote database."),
  Command.withShortDescription("Dumps data or schemas from the remote database"),
  Command.withHandler((flags) =>
    dbDump(flags).pipe(
      withCommandTelemetry({
        flags: {
          "dry-run": flags.dryRun,
          "data-only": flags.dataOnly,
          "use-copy": flags.useCopy,
          exclude: flags.exclude,
          "role-only": flags.roleOnly,
          "keep-comments": flags.keepComments,
          file: flags.file,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // Never add `password` to `safeFlags`; it must stay `<redacted>` in telemetry.
          password: flags.password,
          schema: flags.schema,
        },
        // Not on the established `--project-ref` safeFlags allowlist, so it stays redacted.
        aliases: { s: "schema", x: "exclude", f: "file", p: "password" },
      }),
      Effect.catchTag("DbDumpRunError", onRunFailure),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbDumpRuntimeLayer),
);
