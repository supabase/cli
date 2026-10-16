import { artifactServiceKinds } from "@supabase/stack/internal/artifacts";
import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackUpdate } from "./update.handler.ts";

const config = {
  services: Argument.String("service").pipe(
    Argument.withDescription(
      `Services to update; every service when omitted. One of: ${artifactServiceKinds().join(", ")}.`,
    ),
    Argument.variadic(),
  ),
} as const;

export type StackUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription(
    "Re-resolve the named local service versions (all when none are named) in supabase/supabase.lock, even when their entries are up to date: " +
      "a release specifier moves to its newest published revision, bundled and linked entries to this CLI's pin, and an exact revision stays. " +
      "Nothing is downloaded; supabase start and supabase stack install fetch what the lock names.",
  ),
  Command.withShortDescription("Update locked local service versions"),
  Command.withExamples([
    {
      command: "supabase stack update",
      description: "Move every service to what its specifier now resolves to",
    },
    {
      command: "supabase stack update auth studio",
      description: "Update only auth and studio",
    },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler((flags) =>
    stackUpdate(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
);
