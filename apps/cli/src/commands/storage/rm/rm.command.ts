import { Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import {
  StorageLinkedFlagDef,
  StorageLocalFlagDef,
  StorageProjectRefFlagDef,
  assertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { storageRm } from "./rm.handler.ts";

const config = {
  files: Argument.string("file").pipe(
    Argument.withDescription("File paths to remove."),
    Argument.variadic(),
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively remove a directory."),
    Flag.withDefault(false),
  ),
  linked: StorageLinkedFlagDef,
  local: StorageLocalFlagDef,
  projectRef: StorageProjectRefFlagDef,
} as const;

export const storageRmCommand = Command.make("rm", config).pipe(
  Command.withDescription("Remove objects by file path."),
  Command.withShortDescription("Remove objects by file path"),
  Command.withExamples([
    {
      command: "supabase storage rm -r ss:///bucket/docs",
      description: "Recursively remove a directory from storage",
    },
    {
      command: "supabase storage rm ss:///bucket/docs/example.md ss:///bucket/readme.md",
      description: "Remove multiple files from storage",
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
      return yield* storageRm({
        files: flags.files.map(String),
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
        projectRef: flags.projectRef,
      }).pipe(
        // project-ref isn't on the safe-flags allowlist, so it stays redacted in telemetry.
        withCommandTelemetry({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(Layer.mergeAll(storageGatewayRuntimeLayer(["storage", "rm"]), stdinLayer)),
);
