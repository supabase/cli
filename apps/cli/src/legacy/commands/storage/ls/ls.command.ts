import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import {
  LegacyStorageLinkedFlagDef,
  LegacyStorageLocalFlagDef,
  legacyAssertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { legacyStorageLs } from "./ls.handler.ts";

const config = {
  path: Argument.string("path").pipe(
    Argument.withDescription("Storage path to list (e.g. ss:///bucket/docs)."),
    Argument.optional,
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively list a directory."),
  ),
  linked: LegacyStorageLinkedFlagDef,
  local: LegacyStorageLocalFlagDef,
} as const;

export type LegacyStorageLsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageLsCommand = Command.make("ls", config).pipe(
  Command.withDescription("List objects by path prefix."),
  Command.withShortDescription("List objects by path prefix"),
  Command.withExamples([
    {
      command: "supabase storage ls ss:///bucket/docs",
      description: "List objects at a storage path",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Enforce --linked/--local mutual exclusivity BEFORE instrumentation, so a
      // flag-validation rejection doesn't emit `cli_command_executed` (Go rejects
      // it at cobra flag validation, before RunE/PostRun).
      const cliArgs = yield* CliArgs;
      yield* legacyAssertStorageTargetsExclusive(cliArgs.args);
      // Go gates `storageCmd` behind `--experimental` in PersistentPreRunE
      // (root.go:91-96), after flag-group validation and before RunE/PostRun.
      yield* legacyRequireExperimental;
      const telemetryFlags = {
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
      };
      return yield* legacyStorageLs(flags).pipe(
        withLegacyCommandInstrumentation({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacyStorageGatewayRuntimeLayer(["storage", "ls"])),
);
