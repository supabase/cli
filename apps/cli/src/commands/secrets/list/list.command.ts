import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type SecretsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all secrets in the linked project."),
  Command.withShortDescription("List all secrets on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets list",
      description: "List all secrets for the linked project",
    },
    {
      command: "supabase secrets list --project-ref abcdefghijklmnopqrst",
      description: "List secrets for a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    secretsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["secrets", "list"])),
);
