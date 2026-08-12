import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { legacyParseSchemaFlags } from "../../../shared/legacy-schema-flags.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LegacyDbDumpRunError } from "./dump.errors.ts";
import { legacyDbDump } from "./dump.handler.ts";
import { legacyDbDumpRuntimeLayer } from "./dump.layers.ts";

/**
 * `db dump` streams the pg_dump SQL to stdout (or `--file`) in every output
 * format — there is no `--output-format` for it, so there is no machine
 * envelope. A *run* failure (non-zero container exit) would otherwise let
 * `withJsonErrorHandling` append a JSON error object to stdout after the SQL
 * has already been written, corrupting machine consumers. In json/stream-json
 * mode send the diagnostic to stderr and exit 1 instead; text mode keeps
 * normal error rendering.
 */
const onRunFailure = (error: LegacyDbDumpRunError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* Effect.fail(error);
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

const config = {
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Prints the pg_dump script that would be executed."),
  ),
  // The boolean flags in mutually-exclusive groups (`data-only`/`role-only`/
  // `keep-comments` and the `db-url`/`linked`/`local` target group) are
  // modelled as `Option` so presence tracks whether the flag was explicitly
  // set: group validation and dump's target selection key off that, not the
  // value, so e.g. `--data-only=false` still counts as set. Handlers read the
  // value via `Option.getOrElse(..., () => false)` where the value actually
  // matters.
  dataOnly: Flag.boolean("data-only").pipe(
    Flag.withDescription("Dumps only data records."),
    Flag.optional,
  ),
  useCopy: Flag.boolean("use-copy").pipe(
    Flag.withDescription("Use copy statements in place of inserts."),
  ),
  exclude: Flag.string("exclude").pipe(
    Flag.withAlias("x"),
    Flag.withDescription("List of schema.tables to exclude from data-only dump."),
    Flag.atLeast(0),
    // --exclude/-x is a CSV string-slice value; use the shared pflag-faithful
    // helper so quoted commas survive and malformed CSV fails at parse time.
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  roleOnly: Flag.boolean("role-only").pipe(
    Flag.withDescription("Dumps only cluster roles."),
    Flag.optional,
  ),
  keepComments: Flag.boolean("keep-comments").pipe(
    Flag.withDescription("Keeps commented lines from pg_dump output."),
    Flag.optional,
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("File path to save the dumped contents."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Dumps from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Dumps from the linked project."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Dumps from the local database."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // --schema/-s is a CSV string-slice value; same CSV semantics as --exclude above.
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type LegacyDbDumpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbDumpCommand = Command.make("dump", config).pipe(
  Command.withDescription("Dumps data or schemas from the remote database."),
  Command.withShortDescription("Dumps data or schemas from the remote database"),
  Command.withHandler((flags) =>
    legacyDbDump(flags).pipe(
      withLegacyCommandInstrumentation({
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
          // `password` must never be added to `safeFlags` — it is a credential and
          // must always reach telemetry as `<redacted>`.
          password: flags.password,
          schema: flags.schema,
        },
        // Map dump's shorthand flags to their canonical names so a shorthand
        // invocation (`-s`/`-x`/`-f`/`-p`) is reported in telemetry under the
        // long name.
        aliases: { s: "schema", x: "exclude", f: "file", p: "password" },
      }),
      Effect.catchTag("LegacyDbDumpRunError", onRunFailure),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbDumpRuntimeLayer),
);
