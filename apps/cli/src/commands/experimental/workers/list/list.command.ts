import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { workersList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersListCommand = Command.make("list", config).pipe(
  Command.withDescription(
    "List this project's workers, deployed or not: the union of supabase/config.toml's entries and what the Workers API reports.",
  ),
  Command.withShortDescription("List this project's workers"),
  Command.withExamples([
    {
      command: "supabase experimental workers list",
      description: "See every worker in the linked project",
    },
  ]),
  Command.withHandler((flags) =>
    workersList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["experimental", "workers", "list"])),
);
