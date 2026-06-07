import type * as CliCommand from "effect/unstable/cli/Command";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySecretsUnset } from "./unset.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  names: Argument.string("NAME").pipe(
    Argument.withDescription("Secret names to unset."),
    Argument.variadic(),
  ),
} as const;

export type LegacySecretsUnsetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySecretsUnsetCommand = Command.make("unset", config).pipe(
  Command.withDescription("Unset a secret(s) from the linked Supabase project."),
  Command.withShortDescription("Unset a secret(s) on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets unset MY_SECRET",
      description: "Unset a secret by name",
    },
    {
      command: "supabase secrets unset MY_SECRET OTHER_SECRET",
      description: "Unset multiple secrets",
    },
  ]),
  Command.withHandler((flags) =>
    legacySecretsUnset(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["secrets", "unset"])),
);
