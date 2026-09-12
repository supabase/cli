import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { storageInvalidJobsMessage } from "../storage.errors.ts";
import { parseUintBase0 } from "../../../command-internal/parse-uint.ts";
import {
  StorageLinkedFlagDef,
  StorageLocalFlagDef,
  StorageProjectRefFlagDef,
  assertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { storageCp } from "./cp.handler.ts";

// Effect CLI renders no flag defaults, so the established `(default …)` tokens are written into
// the descriptions below (`--content-type`'s actual runtime default is `""` for auto-detect).
// Flags are declared before `src`/`dst` on purpose: Effect CLI validates flags before positional
// args in declaration order, so a malformed `--jobs` must fail before a missing-operand error.
const config = {
  recursive: Flag.Boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively copy a directory."),
    Flag.withDefault(false),
  ),
  cacheControl: Flag.String("cache-control").pipe(
    Flag.withDescription('Custom Cache-Control header for HTTP upload. (default "max-age=3600")'),
    Flag.optional,
  ),
  contentType: Flag.String("content-type").pipe(
    Flag.withDescription('Custom Content-Type header for HTTP upload. (default "auto-detect")'),
    Flag.optional,
  ),
  jobs: Flag.String("jobs").pipe(
    Flag.withAlias("j"),
    // Declared as a string, not `Flag.Int`, so the raw token reaches the parser below;
    // `withMetavar` keeps the `--jobs, -j integer` help token.
    Flag.withMetavar("integer"),
    Flag.withDescription("Maximum number of parallel jobs. (default 1)"),
    // `--jobs` is a pflag-style uint: a non-uint token must fail at parse time, before the
    // experimental gate, the handler, or any telemetry, with pflag's exact message and original
    // spelling preserved. `Flag.Int` loses that fidelity (`-0` normalizes to negative zero,
    // which a `value < 0` check would wrongly accept), so this parses the raw token with
    // `parseUintBase0` instead; it must sit before `Flag.optional`, which passes `InvalidValue`
    // through untouched.
    Flag.mapTryCatch(
      (token) => {
        const parsed = parseUintBase0(token);
        if ("cause" in parsed) {
          throw new Error(storageInvalidJobsMessage(token, parsed.cause));
        }
        return parsed.value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    Flag.optional,
  ),
  linked: StorageLinkedFlagDef,
  local: StorageLocalFlagDef,
  projectRef: StorageProjectRefFlagDef,
  src: Argument.String("src").pipe(Argument.withDescription("Source path to copy from.")),
  dst: Argument.String("dst").pipe(Argument.withDescription("Destination path to copy to.")),
} as const;

export type StorageCpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const storageCpCommand = Command.make("cp", config).pipe(
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
      // Gate before the mutex check below; see requireExperimental's doc comment for why. A
      // non-uint `--jobs` never reaches here — `Flag.mapTryCatch` rejects it at parse time.
      yield* requireExperimental;
      const cliArgs = yield* CliArgs;
      yield* assertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        cacheControl: flags.cacheControl,
        contentType: flags.contentType,
        jobs: flags.jobs,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      };
      return yield* storageCp(flags).pipe(
        // Not in the safe-flags allowlist, so `--project-ref` stays redacted.
        withCommandTelemetry({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "cp"])),
);
