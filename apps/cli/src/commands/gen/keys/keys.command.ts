import { Command, Flag } from "effect/unstable/cli";
import { removedCommand } from "../../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  overrideName: Flag.string("override-name").pipe(
    Flag.withDescription("Override specific variable names."),
    Flag.atLeast(0),
  ),
} as const;

export const genKeysCommand = Command.make("keys", config).pipe(
  Command.withDescription("Removed: use `supabase projects api-keys --project-ref <ref>` instead."),
  Command.withShortDescription("Removed: use `projects api-keys` instead"),
  Command.withHandler(() =>
    removedCommand(
      "Use `supabase projects api-keys --project-ref <ref>` to read a project's API keys.",
    ).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["gen", "keys"])),
  Command.provide(telemetryStateLayer),
);
