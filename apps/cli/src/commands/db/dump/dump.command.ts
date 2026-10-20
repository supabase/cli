import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig, dbConfigPoolerFallback } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { DbDumpRunError } from "./dump.errors.ts";
import { dbDump } from "./dump.handler.ts";
import { dbDumpRuntimeLayer } from "./dump.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

/**
 * `db dump` has no `--output-format` machine envelope; it streams pg_dump SQL to
 * stdout (or `--file`) in every mode. A run failure (nonzero container exit) sends the
 * diagnostic to stderr and exits 1 in json/stream-json mode instead of letting
 * `withJsonErrorHandling` corrupt already-written SQL with a JSON error object.
 */
const onRunFailure = (error: DbDumpRunError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* error;
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

const config = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Prints the pg_dump script that would be executed."),
    Flag.withDefault(false),
  ),
  // Mutually-exclusive-group flags (data-only/role-only/keep-comments) are modelled as
  // `Option` so presence, not value, drives validation — `--data-only=false` still counts as set.
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
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote. Not used for the local database or a database URL.",
  }),
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
  Command.withDescription("Dumps data or schemas from a database."),
  Command.withShortDescription("Dumps data or schemas from a database"),
  withPermissions(
    compose(
      {
        operations: [],
        noApiEffectFlags: [
          "dry-run",
          "data-only",
          "use-copy",
          "exclude",
          "role-only",
          "keep-comments",
          "file",
          "schema",
        ],
      },
      dbConfig,
      dbConfigPoolerFallback,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
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
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // Never add `password` to `safeFlags`; it must stay `<redacted>` in telemetry.
          password: flags.password,
          schema: flags.schema,
        },
        aliases: { s: "schema", x: "exclude", f: "file", p: "password" },
      }),
      Effect.catchTag("DbDumpRunError", onRunFailure),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbDumpRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the target and writes only a local dump",
  }),
);
