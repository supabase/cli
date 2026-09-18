import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsCreate } from "./create.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  customHostname: Flag.string("custom-hostname").pipe(
    Flag.withDescription("The custom hostname to use for your Supabase project."),
  ),
  includeRawOutput: Flag.boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
    Flag.withDefault(false),
  ),
} as const;

export type DomainsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription(
    "Create a custom hostname for your Supabase project. Expects your custom hostname to have a CNAME record to your Supabase project's subdomain.",
  ),
  Command.withShortDescription("Create a custom hostname"),
  Command.withExamples([
    {
      command:
        "supabase domains create --custom-hostname example.com --project-ref abcdefghijklmnopqrst",
      description: "Create a custom hostname for a project",
    },
  ]),
  Command.withHandler((flags) =>
    domainsCreate(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["domains", "create"])),
);
