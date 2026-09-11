import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import {
  StorageLinkedFlagDef,
  StorageLocalFlagDef,
  StorageProjectRefFlagDef,
  assertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { storageMv } from "./mv.handler.ts";

const config = {
  src: Argument.String("src").pipe(Argument.withDescription("Source path to move from.")),
  dst: Argument.String("dst").pipe(Argument.withDescription("Destination path to move to.")),
  recursive: Flag.Boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively move a directory."),
    Flag.withDefault(false),
  ),
  linked: StorageLinkedFlagDef,
  local: StorageLocalFlagDef,
  projectRef: StorageProjectRefFlagDef,
} as const;

export type StorageMvFlags = CliCommand.Command.Config.Infer<typeof config>;

export const storageMvCommand = Command.make("mv", config).pipe(
  Command.withDescription("Move objects from src to dst path."),
  Command.withShortDescription("Move objects from src to dst path"),
  Command.withExamples([
    {
      command: "supabase storage mv -r ss:///bucket/docs ss:///bucket/www/docs",
      description: "Recursively move a directory within storage",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Gate before the mutex check below; see requireExperimental's doc comment for why.
      yield* requireExperimental;
      const cliArgs = yield* CliArgs;
      yield* assertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      };
      return yield* storageMv(flags).pipe(
        // Not in the safe-flags allowlist, so `--project-ref` stays redacted.
        withCommandTelemetry({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "mv"])),
);
