import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../../../command-internal/command-permissions/model.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { dbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { dbSchemaDeclarativeSync } from "./sync.handler.ts";
import { dbSchemaDeclarativeSyncRuntimeLayer } from "./sync.layers.ts";
import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../../../shared/cli/cli-params.ts";

const config = {
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  file: cliFlag("file", Flag.String, {
    description: "Name for the new migration file, used when --name is not set.",
    alias: "f",
    optional: true,
    docs: { default: "declarative_sync" },
  }),
  name: cliFlag("name", Flag.String, {
    description: "Name for the new migration file.",
    optional: true,
  }),
  // Mutually exclusive with `--no-apply`, keyed off presence not value, so model with `Option`
  // so `--apply=false --no-apply` still trips the conflict.
  apply: cliFlag("apply", Flag.Boolean, {
    description: "Apply the new migration to the local database without asking.",
    optional: true,
  }),
  noApply: cliFlag("no-apply", Flag.Boolean, {
    description:
      "Write the migration file without asking and without applying it to the local database.",
    optional: true,
  }),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type DbSchemaDeclarativeSyncFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
  readonly strictCoverage: boolean;
};

export const dbSchemaDeclarativeSyncCommand = makeCommand("sync", config).pipe(
  Command.withDescription(
    "Compare the migrations baseline with your declarative schema files and write the difference as a new migration. When a legacy export omits known implicit extensions, an interactive run can add their declarations and re-plan before writing. Pass --no-apply to only write the file, or --apply or --yes to also apply it to the local database and update its migration history.",
  ),
  Command.withShortDescription("Generate a migration from declarative schema"),
  withPermissions(
    compose({
      operations: [],
      noApiEffectFlags: [
        "schema",
        "file",
        "name",
        "apply",
        "no-apply",
        "no-cache",
        "strict-coverage",
      ],
    }),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // `--no-cache` is shared on the parent group; read the resolved value there.
      const shared = yield* dbSchemaDeclarativeSharedBase;
      const merged: DbSchemaDeclarativeSyncFlags = {
        ...flags,
        noCache: shared.noCache,
        strictCoverage: shared.strictCoverage,
      };
      return yield* dbSchemaDeclarativeSync(merged).pipe(
        withCommandTelemetry({
          flags: {
            "no-cache": merged.noCache,
            "strict-coverage": merged.strictCoverage,
            schema: merged.schema,
            file: merged.file,
            name: merged.name,
            apply: merged.apply,
            "no-apply": merged.noApply,
          },
          // Telemetry reports changed flags by canonical name, so map the shorthands: `sync
          // -s public -f out.sql` must log `schema`/`file`.
          aliases: { s: "schema", f: "file" },
        }),
        withJsonErrorHandling,
      );
    }),
  ),
  Command.provide(dbSchemaDeclarativeSyncRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
