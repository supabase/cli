import { Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { STORAGE_PERMISSIONS, storageTargetFlags } from "../storage.flags.ts";
import { storageRm } from "./rm.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  files: Argument.String("file").pipe(
    Argument.withDescription("File paths to remove."),
    Argument.variadic(),
  ),
  recursive: Flag.Boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively remove a directory."),
    Flag.withDefault(false),
  ),
  ...storageTargetFlags,
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
  withPermissions(STORAGE_PERMISSIONS),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireExperimental;
      const telemetryFlags = {
        recursive: flags.recursive,
        remote: flags.remote,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      };
      return yield* storageRm({
        files: flags.files.map(String),
        recursive: flags.recursive,
        remote: flags.remote,
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
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
