import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersStatus } from "./status.handler.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Worker to inspect.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersStatusCommand = Command.make("status", config).pipe(
  Command.withDescription(
    "Show one worker in detail: build state, size, access, image, live instance tally and source directory.",
  ),
  Command.withShortDescription("Show a worker in detail"),
  Command.withExamples([
    {
      command: "supabase workers status api",
      description: "Inspect a specific worker",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersStatus(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["workers", "status"])),
);
