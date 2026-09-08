import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { backupsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type BackupsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const backupsListCommand = Command.make("list", config).pipe(
  Command.withDescription("Lists available physical backups"),
  Command.withShortDescription("Lists available physical backups"),
  Command.withExamples([
    {
      command: "supabase backups list",
      description: "List all physical backups",
    },
    {
      command: "supabase backups list --project-ref <ref>",
      description: "List backups for a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    backupsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["backups", "list"])),
);
