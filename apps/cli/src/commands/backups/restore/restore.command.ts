import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { backupsRestore } from "./restore.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  timestamp: Flag.Int("timestamp").pipe(
    Flag.withAlias("t"),
    Flag.withDescription("The recovery time target in seconds since epoch."),
    Flag.optional,
  ),
} as const;

export type BackupsRestoreFlags = CliCommand.Command.Config.Infer<typeof config>;

export const backupsRestoreCommand = Command.make("restore", config).pipe(
  Command.withDescription("Restore to a specific timestamp using PITR"),
  Command.withShortDescription("Restore to a specific timestamp using PITR"),
  Command.withExamples([
    {
      command: "supabase backups restore --timestamp 1707407047",
      description: "Restore to the given Unix epoch timestamp",
    },
  ]),
  Command.withHandler((flags) =>
    backupsRestore(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["backups", "restore"])),
);
