import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  includeRawOutput: Flag.boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
    Flag.withDefault(false),
  ),
} as const;

export type DomainsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsGetCommand = Command.make("get", config).pipe(
  Command.withDescription(
    "Retrieve the custom hostname config for your project, as stored in the Supabase platform.",
  ),
  Command.withShortDescription("Get the current custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains get --project-ref abcdefghijklmnopqrst",
      description: "Get the custom hostname config for a project",
    },
  ]),
  Command.withHandler((flags) =>
    domainsGet(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["domains", "get"])),
);
