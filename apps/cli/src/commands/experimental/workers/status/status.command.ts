import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { workersStatus } from "./status.handler.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Worker to inspect.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersStatusCommand = Command.make("status", config).pipe(
  Command.withDescription(
    "Show one worker in detail: build state, size, access, image, live instance tally and source directory.",
  ),
  Command.withShortDescription("Show a worker in detail"),
  Command.withExamples([
    {
      command: "supabase experimental workers status api",
      description: "Inspect a specific worker",
    },
  ]),
  Command.withHandler((flags) =>
    workersStatus(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["experimental", "workers", "status"])),
);
