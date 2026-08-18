import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersDelete } from "./delete.handler.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Worker to delete.")),
  yes: Flag.boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Skip the confirmation prompt."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a worker from the linked Supabase project. Irreversible; its local directory and supabase/config.toml entry are kept.",
  ),
  Command.withShortDescription("Delete a worker from Supabase"),
  Command.withExamples([
    {
      command: "supabase workers delete api",
      description: "Delete a worker, confirming by typing its name",
    },
    {
      command: "supabase workers delete api --yes",
      description: "Skip the confirmation prompt (scripts and CI)",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersDelete(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["workers", "delete"])),
);
