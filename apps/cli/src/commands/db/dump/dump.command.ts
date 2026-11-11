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
import { cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

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
  dryRun: cliFlag("dry-run", Flag.Boolean, {
    description: "Print the pg_dump script that would run, without running it.",
    default: false,
  }),
  // Mutually-exclusive-group flags (data-only/role-only/keep-comments) are modelled as
  // `Option` so presence, not value, drives validation — `--data-only=false` still counts as set.
  dataOnly: cliFlag("data-only", Flag.Boolean, {
    description: "Dump only data records.",
    optional: true,
  }),
  useCopy: cliFlag("use-copy", Flag.Boolean, {
    description: "Use COPY statements instead of INSERT statements.",
    default: false,
  }),
  exclude: cliFlag("exclude", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schema.table names to exclude from a data-only dump.",
    alias: "x",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  roleOnly: cliFlag("role-only", Flag.Boolean, {
    description: "Dump only cluster roles.",
    optional: true,
  }),
  keepComments: cliFlag("keep-comments", Flag.Boolean, {
    description: "Keep commented lines from the pg_dump output.",
    optional: true,
  }),
  file: cliFlag("file", Flag.String, {
    description: "File path to save the dumped contents to.",
    alias: "f",
    optional: true,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
} as const;

export type DbDumpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbDumpCommand = makeCommand("dump", config).pipe(
  Command.withDescription(
    "Export the schema, data, or custom roles of a database to a SQL script with pg_dump. Use it to back up a database or to copy it to another project.",
  ),
  Command.withShortDescription("Dump data or schemas from a database"),
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
