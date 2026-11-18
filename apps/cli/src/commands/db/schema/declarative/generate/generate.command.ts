import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
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
import { branchResolution } from "../../../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  overwrite: cliFlag("overwrite", Flag.Boolean, {
    description: "Overwrite existing declarative schema files without asking.",
    default: false,
  }),
  // Not named `--output`/`-o`: that's reserved for the global machine-format flag
  // (`OutputFlag`), and a leaf string flag would shadow it — `generate -o json` would write a
  // directory literally named `json` instead of requesting JSON output.
  outputDir: cliFlag("output-dir", Flag.String, {
    description:
      "Write the generated declarative schema to this directory instead of the configured declarative schema path.",
    optional: true,
  }),
  reset: cliFlag("reset", Flag.Boolean, {
    description:
      "Reset the local database from your migrations before generating, which discards local data.",
    default: false,
  }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type DbSchemaDeclarativeGenerateFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
  readonly strictCoverage: boolean;
};

export const dbSchemaDeclarativeGenerateCommand = makeCommand("generate", config).pipe(
  Command.withDescription(
    "Export the schema of a live database as a complete tree of declarative SQL files, the starting point for declarative mode. It replaces declarative files only and does not create migrations or update migration history. It exports from the local database unless --remote selects another.",
  ),
  Command.withShortDescription("Generate declarative schema from a database"),
  Command.withExamples([
    {
      command: "supabase db schema declarative generate",
      description: "Export the local database as declarative schema files",
    },
    {
      command: "supabase db schema declarative generate --remote --overwrite",
      description: "Replace the declarative files with the schema of the linked project",
    },
  ]),
  withPermissions(
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
      branchResolution,
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
