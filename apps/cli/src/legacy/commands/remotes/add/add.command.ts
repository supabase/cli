import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRemotesAdd } from "./add.handler.ts";
import { legacyRemotesRuntimeLayer } from "../remotes.layers.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name for the remote.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref the remote targets."),
  ),
} as const;

export type LegacyRemotesAddFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyRemotesAddCommand = Command.make("add", config).pipe(
  Command.withDescription(
    "Register a named remote Supabase project in supabase/config.toml. Idempotent when the name already targets the same ref.",
  ),
  Command.withShortDescription("Register a remote"),
  Command.withHandler((flags) =>
    legacyRemotesAdd(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyRemotesRuntimeLayer(["remotes", "add"])),
);
