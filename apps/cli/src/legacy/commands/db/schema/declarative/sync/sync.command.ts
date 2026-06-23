import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../../../shared/output/json-error-handling.ts";
import { legacyParseSchemaFlags } from "../../../../../shared/legacy-schema-flags.ts";
import { withLegacyCommandInstrumentation } from "../../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { legacyDbSchemaDeclarativeSync } from "./sync.handler.ts";
import { legacyDbSchemaDeclarativeSyncRuntimeLayer } from "./sync.layers.ts";

const config = {
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // Go registers `--schema` as a cobra `StringSliceVarP`
    // (`apps/cli-go/cmd/db_schema_declarative.go:484`), which CSV-splits each
    // occurrence so `-s public,auth` includes the two schemas separately. Mirror
    // the `gen types` / `db lint` parsing so quoted commas are handled the same way.
    Flag.mapTryCatch(
      (rawValues) => legacyParseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves schema diff to a new migration file."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the generated migration file."),
    Flag.optional,
  ),
  // cobra's `MarkFlagsMutuallyExclusive("apply", "no-apply")` keys off `flag.Changed`,
  // not the value (`cmd/db_schema_declarative.go:490`), so model presence with `Option`
  // so `--apply=false --no-apply` still trips the conflict. The apply decision below
  // reads the resolved value via `Option.getOrElse`.
  apply: Flag.boolean("apply").pipe(
    Flag.withDescription("Apply the generated migration to the local database without prompting."),
    Flag.optional,
  ),
  noApply: Flag.boolean("no-apply").pipe(
    Flag.withDescription(
      "Generate the migration file without prompting or applying it to the local database.",
    ),
    Flag.optional,
  ),
} as const;

// `--no-cache` is a shared flag on the `declarative` group (read from the parent),
// so the handler input merges it in alongside the leaf's own flags.
export type LegacyDbSchemaDeclarativeSyncFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
};

export const legacyDbSchemaDeclarativeSyncCommand = Command.make("sync", config).pipe(
  Command.withDescription("Generate a new migration from declarative schema."),
  Command.withShortDescription("Generate a new migration from declarative schema"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // `--no-cache` is shared on the parent group; read the resolved value there.
      const shared = yield* legacyDbSchemaDeclarativeSharedBase;
      const merged: LegacyDbSchemaDeclarativeSyncFlags = { ...flags, noCache: shared.noCache };
      return yield* legacyDbSchemaDeclarativeSync(merged).pipe(
        withLegacyCommandInstrumentation({
          flags: {
            "no-cache": merged.noCache,
            schema: merged.schema,
            file: merged.file,
            name: merged.name,
            apply: merged.apply,
            "no-apply": merged.noApply,
          },
          // Go registers `--schema`/`-s` (StringSliceVarP) and `--file`/`-f`
          // (StringVarP) (`cmd/db_schema_declarative.go:484-485`); telemetry reports
          // changed flags by canonical `flag.Name` via `pflag.Visit`, so map the
          // shorthands so `sync -s public -f out.sql` logs `schema`/`file`.
          aliases: { s: "schema", f: "file" },
        }),
        withJsonErrorHandling,
      );
    }),
  ),
  Command.provide(legacyDbSchemaDeclarativeSyncRuntimeLayer),
);
