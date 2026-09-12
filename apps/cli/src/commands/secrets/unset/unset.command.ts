import type * as CliCommand from "effect/unstable/cli/Command";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { Layer } from "effect";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsUnset } from "./unset.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  names: Argument.String("NAME").pipe(
    Argument.withDescription("Secret names to unset."),
    Argument.variadic(),
  ),
} as const;

export type SecretsUnsetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsUnsetCommand = Command.make("unset", config).pipe(
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
    secretsUnset(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  // `stdinLayer`: the confirmation prompt reads piped stdin via `promptYesNo` on a non-TTY stdin.
  Command.provide(Layer.mergeAll(managementApiRuntimeLayer(["secrets", "unset"]), stdinLayer)),
);
