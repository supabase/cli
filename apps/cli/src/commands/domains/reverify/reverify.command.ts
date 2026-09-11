import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsReverify } from "./reverify.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  includeRawOutput: Flag.Boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
    Flag.withDefault(false),
  ),
} as const;

export type DomainsReverifyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsReverifyCommand = Command.make("reverify", config).pipe(
  Command.withDescription("Re-verify the custom hostname config for your project."),
  Command.withShortDescription("Re-verify the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains reverify --project-ref abcdefghijklmnopqrst",
      description: "Re-verify the custom hostname for a project",
    },
  ]),
  Command.withHandler((flags) =>
    domainsReverify(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["domains", "reverify"])),
);
