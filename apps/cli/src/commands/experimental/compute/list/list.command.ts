import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type ComputeListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeListCommand = Command.make("list", config).pipe(
  Command.withDescription(
    "List this project's compute, deployed or not: the union of supabase/config.toml's entries and what the Compute API reports.",
  ),
  Command.withShortDescription("List this project's compute"),
  Command.withExamples([
    {
      command: "supabase compute list",
      description: "See every compute in the linked project",
    },
  ]),
  Command.withHandler((flags) =>
    computeList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "list"])),
);
