import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { aqua } from "../../../../../command-internal/colors.ts";
import { parseSchemaFlags } from "../../../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { dbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { dbSchemaDeclarativeGenerate } from "./generate.handler.ts";
import { dbSchemaDeclarativeGenerateRuntimeLayer } from "./generate.layers.ts";
import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { targetFlags } from "../../../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  overwrite: Flag.Boolean("overwrite").pipe(
    Flag.withDescription("Overwrite declarative schema files without confirmation."),
    Flag.withDefault(false),
  ),
  // Not named `--output`/`-o`: that's reserved for the global machine-format flag
  // (`OutputFlag`), and a leaf string flag would shadow it — `generate -o json` would write a
  // directory literally named `json` instead of requesting JSON output.
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription(
      "Write the generated declarative schema to this directory without changing the configured declarative schema path.",
    ),
    Flag.optional,
  ),
  reset: Flag.Boolean("reset").pipe(
    Flag.withDescription("Reset local database before generating (local data will be lost)."),
    Flag.withDefault(false),
  ),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // CSV-splits each occurrence so `-s public,auth` includes the two schemas separately, same
    // as `gen types`/`db lint`'s quoted-comma parsing.
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote. Not used for the local database or a database URL.",
  }),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type DbSchemaDeclarativeGenerateFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
  readonly strictCoverage: boolean;
};

export const dbSchemaDeclarativeGenerateCommand = Command.make("generate", config).pipe(
  Command.withDescription(
    "Exports a live database into the complete declarative schema tree. This replaces declarative files only; it does not create migration files or update migration history. Use --output-dir to stage an export without changing the configured declarative path. Generates from the local database unless --remote selects another.",
  ),
  Command.withShortDescription("Generate declarative schema from a database"),
  withPermissions(
    withDbTarget(
      compose(
        {
          operations: [],
          noApiEffectFlags: [
            "overwrite",
            "output-dir",
            "reset",
            "schema",
            "no-cache",
            "strict-coverage",
          ],
        },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // `--no-cache` is shared on the parent group; read the resolved value there.
      const shared = yield* dbSchemaDeclarativeSharedBase;
      const merged: DbSchemaDeclarativeGenerateFlags = {
        ...flags,
        noCache: shared.noCache,
        strictCoverage: shared.strictCoverage,
      };
      return yield* dbSchemaDeclarativeGenerate(merged).pipe(
        // Printed on stdout in text mode; in json/stream-json the bare human line would corrupt
        // the payload, so emit a structured result instead (machine stdout is payload-only).
        Effect.tap(() =>
          Effect.gen(function* () {
            const output = yield* Output;
            if (output.format === "text") {
              yield* output.raw(`Finished ${aqua("supabase db schema declarative generate")}.\n`);
              return;
            }
            yield* output.success("Finished supabase db schema declarative generate.");
          }),
        ),
        withCommandTelemetry({
          flags: {
            "no-cache": merged.noCache,
            "strict-coverage": merged.strictCoverage,
            overwrite: merged.overwrite,
            "output-dir": merged.outputDir,
            reset: merged.reset,
            schema: merged.schema,
            remote: merged.remote,
            "db-url": merged.dbUrl,
            linked: merged.linked,
            local: merged.local,
            "project-ref": merged.projectRef,
            // `password` must never be added to `safeFlags`: it's a credential and must always
            // reach telemetry as `<redacted>`.
            password: merged.password,
          },
          // Telemetry reports changed flags by canonical name, so map the shorthands: `generate
          // -s public -p secret` must log `schema`/`password`.
          aliases: { s: "schema", p: "password" },
        }),
        withJsonErrorHandling,
      );
    }),
  ),
  Command.provide(dbSchemaDeclarativeGenerateRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the target and writes only local declarative files",
  }),
);
