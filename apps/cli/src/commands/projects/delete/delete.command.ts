import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ref: cliArgument("ref", Argument.String, {
    description: "Ref of the project to delete.",
    optional: true,
  }),
};
export type ProjectsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsDeleteCommand = makeCommand("delete", config).pipe(
  Command.withDescription(
    "Delete a Supabase project by its ref. In an interactive terminal, omit the ref to pick a project from a list.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Delete a project"),
  Command.withExamples([
    {
      command: "supabase projects delete abcdefghijklmnopqrst",
      description: "Delete a project by ref",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-list-all-projects",
            kind: "required",
            context:
              "no ref argument (or an empty one) and an interactive terminal (stdin TTY and text output); SUPABASE_PROJECT_ID and supabase/.temp/project-ref are ignored",
          },
          { operationId: "v1-delete-a-project", kind: "required" },
        ],
      },
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    projectsDelete(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: [] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "delete"])),
  withTargetPolicy({ group: "account", consent: "no" }),
);
