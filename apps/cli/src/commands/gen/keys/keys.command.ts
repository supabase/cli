import { Command, Flag } from "effect/cli";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { removedCommand } from "../../../command-internal/removed-command.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
  overrideName: Flag.String("override-name").pipe(
    Flag.withDescription("Override specific variable names."),
    Flag.atLeast(0),
  ),
} as const;

export const genKeysCommand = Command.make("keys", config).pipe(
  Command.withDescription("Removed: use `supabase projects api-keys --remote=<ref>` instead."),
  Command.withShortDescription("Removed: use `projects api-keys` instead"),
  // Removed: fails before any Management API call, so no flag changes what it calls.
  withPermissions({
    operations: [],
    noApiEffectFlags: ["override-name", "project-ref", "remote"],
  }),
  Command.withHandler(() =>
    removedCommand(
      "Use `supabase projects api-keys --remote=<ref>` to read a project's API keys.",
    ).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["gen", "keys"])),
  Command.provide(telemetryStateLayer),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
