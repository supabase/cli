import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { workersDelete } from "./delete.handler.ts";

// No local `--yes`: it is a root persistent flag every other confirming command
// reads through `resolveYes`, so redeclaring it here would shadow the
// global, list `--yes` twice in `--help`, and quietly ignore `SUPABASE_YES`.
const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Worker to delete.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a worker from the linked Supabase project. Irreversible; its local directory and supabase/config.toml entry are kept.",
  ),
  Command.withShortDescription("Delete a worker from Supabase"),
  Command.withExamples([
    {
      command: "supabase experimental workers delete api",
      description: "Delete a worker, confirming by typing its name",
    },
    {
      command: "supabase experimental workers delete api --yes",
      description: "Skip the confirmation prompt (scripts and CI)",
    },
  ]),
  Command.withHandler((flags) =>
    workersDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["experimental", "workers", "delete"])),
);
