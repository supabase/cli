import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ref: Argument.String("ref").pipe(
    Argument.withDescription("Project ref to delete."),
    Argument.optional,
  ),
};
export type ProjectsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a Supabase project."),
  Command.withShortDescription("Delete a project"),
  Command.withExamples([
    {
      command: "supabase projects delete abcdefghijklmnopqrst",
      description: "Delete a project by ref",
    },
  ]),
  Command.withHandler((flags) =>
    projectsDelete(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: [] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "delete"])),
  withTargetPolicy({ group: "account", consent: "no" }),
);
