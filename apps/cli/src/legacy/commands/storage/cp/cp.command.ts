import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import { legacyStorageInvalidJobsMessage } from "../storage.errors.ts";
import { legacyParseUintBase0 } from "../../../shared/legacy-parse-uint.ts";
import {
  LegacyStorageLinkedFlagDef,
  LegacyStorageLocalFlagDef,
  LegacyStorageProjectRefFlagDef,
  legacyAssertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { legacyStorageCp } from "./cp.handler.ts";

// `--linked`/`--local` are scoped globals on the `storage` group. Go's cobra
// help appends a `(default …)` token for every flag with a non-empty default;
// Effect CLI renders no defaults at all, so Go's tokens are reproduced inline in
// the descriptions below to keep `storage cp --help` at parity. `--content-type`
// keeps its empty runtime default (`""` ⇒ auto-detect via sniffing), but Go
// overrides only the *displayed* default to `auto-detect` (`storage.go:106`), so
// the help text — not the resolved value — reads `auto-detect`.
// Flags are declared BEFORE the `src`/`dst` positionals on purpose: Effect CLI
// parses params in config-declaration order (`parseParams` walks
// `orderedParams`, built from record-key order), so this mirrors cobra running
// `ParseFlags` before `ExactArgs(2)` validation (`cmd/storage.go:63,107`) — a
// malformed `--jobs` must win over a missing operand, exactly as in Go.
// Positional mapping is unaffected (only the relative order of Arguments
// matters), and `--help` renders flags in relative declaration order, so the
// help output is unchanged.
const config = {
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively copy a directory."),
  ),
  cacheControl: Flag.string("cache-control").pipe(
    Flag.withDescription('Custom Cache-Control header for HTTP upload. (default "max-age=3600")'),
    Flag.optional,
  ),
  contentType: Flag.string("content-type").pipe(
    Flag.withDescription('Custom Content-Type header for HTTP upload. (default "auto-detect")'),
    Flag.optional,
  ),
  jobs: Flag.string("jobs").pipe(
    Flag.withAlias("j"),
    // Keep the help token `--jobs, -j integer` that `Flag.integer` rendered —
    // the flag is a string only so the RAW token reaches the parser below.
    Flag.withMetavar("integer"),
    Flag.withDescription("Maximum number of parallel jobs. (default 1)"),
    // Go's `--jobs` is a pflag uint (`UintVarP`, `cmd/storage.go:107`), so a
    // non-uint token fails `strconv.ParseUint(s, 0, 64)` at flag-parse time —
    // before cobra's group validation, the experimental gate in
    // `PersistentPreRunE` (`cmd/root.go:93-96`), and RunE, and without
    // emitting telemetry. The raw token is parsed with `legacyParseUintBase0`
    // (an exact ParseUint port) rather than `Flag.integer`, because numeric
    // normalization loses parity: `-0` normalizes to negative zero (which a
    // `value < 0` check accepts, where Go rejects every sign prefix), error
    // messages must carry the original spelling (`-01`, not `-1`), and Go's
    // base-0 forms (`0x10` → 16, `010` → 8, `1_0` → 10) must keep parsing.
    // The resulting `CliError.InvalidValue` carries pflag's complete message,
    // which `formatInvalidValueMessage` surfaces verbatim. Must sit before
    // `Flag.optional`, which passes `InvalidValue` failures through
    // untouched. Because flags are declared ahead of the positionals (see the
    // config comment above), this error also wins when `src`/`dst` are
    // missing, matching Go's flags-before-args order.
    Flag.mapTryCatch(
      (token) => {
        const parsed = legacyParseUintBase0(token);
        if ("cause" in parsed) {
          throw new Error(legacyStorageInvalidJobsMessage(token, parsed.cause));
        }
        return parsed.value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    Flag.optional,
  ),
  linked: LegacyStorageLinkedFlagDef,
  local: LegacyStorageLocalFlagDef,
  projectRef: LegacyStorageProjectRefFlagDef,
  src: Argument.string("src").pipe(Argument.withDescription("Source path to copy from.")),
  dst: Argument.string("dst").pipe(Argument.withDescription("Destination path to copy to.")),
} as const;

export type LegacyStorageCpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageCpCommand = Command.make("cp", config).pipe(
  Command.withDescription("Copy objects from src to dst path."),
  Command.withShortDescription("Copy objects from src to dst path"),
  Command.withExamples([
    {
      command: "supabase storage cp readme.md ss:///bucket/readme.md",
      description: "Upload a local file to storage",
    },
    {
      command: "supabase storage cp -r docs ss:///bucket/docs",
      description: "Upload a directory recursively to storage",
    },
    {
      command: "supabase storage cp -r ss:///bucket/docs .",
      description: "Download a directory from storage",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Gate before the mutex check below — order matters; see
      // legacyRequireExperimental's doc comment for why. (A non-uint `--jobs`
      // never reaches this handler: the flag's own `Flag.mapTryCatch` rejects
      // it at parse time, matching Go's pflag-before-PersistentPreRunE order.)
      yield* legacyRequireExperimental;
      const cliArgs = yield* CliArgs;
      yield* legacyAssertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        cacheControl: flags.cacheControl,
        contentType: flags.contentType,
        jobs: flags.jobs,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      };
      return yield* legacyStorageCp(flags).pipe(
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
        withLegacyCommandInstrumentation({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacyStorageGatewayRuntimeLayer(["storage", "cp"])),
);
