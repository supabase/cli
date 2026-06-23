import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import {
  LegacyStorageLinkedFlagDef,
  LegacyStorageLocalFlagDef,
  legacyAssertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { legacyStorageCp } from "./cp.handler.ts";

// `--linked`/`--local` are scoped globals on the `storage` group. Note the Go
// help shows `--content-type` DefValue `auto-detect`, but the runtime default is
// `""` (empty ⇒ auto-detect); Effect renders the real default (DQ-1, cosmetic).
const config = {
  src: Argument.string("src").pipe(Argument.withDescription("Source path to copy from.")),
  dst: Argument.string("dst").pipe(Argument.withDescription("Destination path to copy to.")),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively copy a directory."),
  ),
  cacheControl: Flag.string("cache-control").pipe(
    Flag.withDescription("Custom Cache-Control header for HTTP upload."),
    Flag.optional,
  ),
  contentType: Flag.string("content-type").pipe(
    Flag.withDescription("Custom Content-Type header for HTTP upload."),
    Flag.optional,
  ),
  jobs: Flag.integer("jobs").pipe(
    Flag.withAlias("j"),
    Flag.withDescription("Maximum number of parallel jobs."),
    Flag.optional,
  ),
  linked: LegacyStorageLinkedFlagDef,
  local: LegacyStorageLocalFlagDef,
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
      const cliArgs = yield* CliArgs;
      yield* legacyAssertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        cacheControl: flags.cacheControl,
        contentType: flags.contentType,
        jobs: flags.jobs,
        linked: flags.linked,
        local: flags.local,
      };
      return yield* legacyStorageCp(flags).pipe(
        withLegacyCommandInstrumentation({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacyStorageGatewayRuntimeLayer(["storage", "cp"])),
);
