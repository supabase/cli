import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { dbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { dbSchemaDeclarativeSync } from "./sync.handler.ts";
import { dbSchemaDeclarativeSyncRuntimeLayer } from "./sync.layers.ts";

const config = {
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
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves schema diff to a new migration file."),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("Name for the generated migration file."),
    Flag.optional,
  ),
  // Mutually exclusive with `--no-apply`, keyed off presence not value, so model with `Option`
  // so `--apply=false --no-apply` still trips the conflict.
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Apply the generated migration to the local database without prompting."),
    Flag.optional,
  ),
  noApply: Flag.Boolean("no-apply").pipe(
    Flag.withDescription(
      "Generate the migration file without prompting or applying it to the local database.",
    ),
    Flag.optional,
  ),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type DbSchemaDeclarativeSyncFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
  readonly strictCoverage: boolean;
};

export const dbSchemaDeclarativeSyncCommand = Command.make("sync", config).pipe(
  Command.withDescription(
    "Compares the supabase/migrations baseline with the complete declarative schema tree and writes the difference as migration files. When a legacy export omits known implicit extensions, interactive sync can add declarations and re-plan before writing. Use --no-apply for non-interactive generation without changing the local database; --apply or global --yes applies locally and updates local migration history.",
  ),
  Command.withShortDescription("Generate a new migration from declarative schema"),
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
);
