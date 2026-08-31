import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersListCommand = Command.make("list", config).pipe(
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
    legacyWorkersList(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["experimental", "workers", "list"])),
);
