import { Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import {
  LegacyStorageLinkedFlagDef,
  LegacyStorageLocalFlagDef,
  legacyAssertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { legacyStorageRm } from "./rm.handler.ts";

const config = {
  files: Argument.string("file").pipe(
    Argument.withDescription("File paths to remove."),
    Argument.variadic(),
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively remove a directory."),
  ),
  linked: LegacyStorageLinkedFlagDef,
  local: LegacyStorageLocalFlagDef,
} as const;

export const legacyStorageRmCommand = Command.make("rm", config).pipe(
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
      return yield* legacyStorageRm({
        files: flags.files.map(String),
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
      }).pipe(withLegacyCommandInstrumentation({ flags: telemetryFlags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(Layer.mergeAll(legacyStorageGatewayRuntimeLayer(["storage", "rm"]), stdinLayer)),
);
