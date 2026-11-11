import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { storageInvalidJobsMessage } from "../storage.errors.ts";
import { parseUintBase0 } from "../../../shared/config/parse-uint.ts";
import { STORAGE_PERMISSIONS, storageTargetFlags } from "../storage.flags.ts";
import { storageCp } from "./cp.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

// Effect CLI renders no flag defaults, so the `(default …)` tokens are written into the
// descriptions below for `--help`; the reference strips them and shows `docs.default` instead
// (`--content-type`'s actual runtime default is `""` for auto-detect).
// Flags are declared before `src`/`dst` on purpose: Effect CLI validates flags before positional
// args in declaration order, so a malformed `--jobs` must fail before a missing-operand error.
const config = {
  recursive: cliFlag("recursive", Flag.Boolean, {
    description: "Recursively copy a directory.",
    alias: "r",
    default: false,
  }),
  cacheControl: cliFlag("cache-control", Flag.String, {
    description: 'Custom Cache-Control header for HTTP upload. (default "max-age=3600")',
    optional: true,
    docs: { default: "max-age=3600" },
  }),
  contentType: cliFlag("content-type", Flag.String, {
    description: 'Custom Content-Type header for HTTP upload. (default "auto-detect")',
    optional: true,
    docs: { default: "auto-detect" },
  }),
  jobs: cliFlag("jobs", Flag.String, {
    description: "Maximum number of parallel jobs. (default 1)",
    alias: "j",
    metavar: "integer",
    parse: Flag.mapTryCatch(
      (token) => {
        const parsed = parseUintBase0(token);
        if ("cause" in parsed) {
          throw new Error(storageInvalidJobsMessage(token, parsed.cause));
        }
        return parsed.value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    optional: true,
    docs: { default: "1" },
  }),
  ...storageTargetFlags,
  src: cliArgument("src", Argument.String, {
    description: "Source path to copy from.",
    required: true,
  }),
  dst: cliArgument("dst", Argument.String, {
    description: "Destination path to copy to.",
    required: true,
  }),
} as const;

export type StorageCpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const storageCpCommand = makeCommand("cp", config).pipe(
  Command.withDescription(
    "Upload local files to Storage, or download objects from Storage to local disk. Exactly one side must be a `ss:///bucket/path` URL; copying between buckets is not supported.\n\nRequires the `--experimental` flag.",
  ),
  Command.withShortDescription("Copy files between local disk and Storage"),
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
  withPermissions(
    compose(STORAGE_PERMISSIONS, {
      operations: [],
      noApiEffectFlags: ["cache-control", "content-type", "jobs"],
    }),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // A non-uint `--jobs` never reaches here: `Flag.mapTryCatch` rejects it at parse time.
      yield* requireExperimental;
      const telemetryFlags = {
        recursive: flags.recursive,
        cacheControl: flags.cacheControl,
        contentType: flags.contentType,
        jobs: flags.jobs,
      };
      return yield* storageCp(flags).pipe(withCommandTelemetry({ flags: telemetryFlags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "cp"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
