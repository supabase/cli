import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { STORAGE_PERMISSIONS, storageTargetFlags } from "../storage.flags.ts";
import { storageMv } from "./mv.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  src: Argument.String("src").pipe(Argument.withDescription("Source path to move from.")),
  dst: Argument.String("dst").pipe(Argument.withDescription("Destination path to move to.")),
  recursive: Flag.Boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively move a directory."),
    Flag.withDefault(false),
  ),
  ...storageTargetFlags,
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
  withPermissions(STORAGE_PERMISSIONS),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireExperimental;
      const telemetryFlags = {
        recursive: flags.recursive,
      };
      return yield* storageMv(flags).pipe(withCommandTelemetry({ flags: telemetryFlags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "mv"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
