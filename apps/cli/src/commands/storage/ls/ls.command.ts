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
import { storageLs } from "./ls.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  path: cliArgument("path", Argument.String, {
    description: "Storage path to list, such as `ss:///bucket/docs`.",
    optional: true,
  }),
  recursive: cliFlag("recursive", Flag.Boolean, {
    description: "Recursively list a directory.",
    alias: "r",
    default: false,
  }),
  ...storageTargetFlags,
} as const;

export type StorageLsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const storageLsCommand = makeCommand("ls", config).pipe(
  Command.withDescription(
    "List the objects under a Storage path such as `ss:///bucket/docs`. Without a path, it lists all buckets.\n\nRequires the `--experimental` flag.",
  ),
  Command.withShortDescription("List objects by path prefix"),
  Command.withExamples([
    {
      command: "supabase storage ls ss:///bucket/docs",
      description: "List objects at a storage path",
    },
  ]),
  withPermissions(STORAGE_PERMISSIONS),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireExperimental;
      const telemetryFlags = {
        recursive: flags.recursive,
      };
      return yield* storageLs(flags).pipe(withCommandTelemetry({ flags: telemetryFlags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "ls"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
);
