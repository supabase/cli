import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { computeDelete } from "./delete.handler.ts";

// No local `--yes`: it is a root persistent flag every other confirming command
// reads through `resolveYes`, so redeclaring it here would shadow the
// global, list `--yes` twice in `--help`, and quietly ignore `SUPABASE_YES`.
const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Compute to delete.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type ComputeDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a compute from the linked Supabase project. Irreversible; its local directory and supabase/config.toml entry are kept.",
  ),
  Command.withShortDescription("Delete a compute from Supabase"),
  Command.withExamples([
    {
      command: "supabase compute delete api",
      description: "Delete a compute, confirming by typing its name",
    },
    {
      command: "supabase compute delete api --yes",
      description: "Skip the confirmation prompt (scripts and CI)",
    },
  ]),
  Command.withHandler((flags) =>
    computeDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "delete"])),
);
