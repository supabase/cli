import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacySecretsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacySecretsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySecretsListCommand = Command.make("list", config).pipe(
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
    legacySecretsList(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["secrets", "list"])),
);
