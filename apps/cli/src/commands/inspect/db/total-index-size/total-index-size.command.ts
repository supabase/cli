import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { removedCommand } from "../../../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";
import { INSPECT_DB_FLAGS } from "../inspect-db-command.ts";
import { inspectDbCommandPath } from "../db.layers.ts";

export const inspectDbTotalIndexSizeCommand = Command.make(
  "total-index-size",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Removed: use `supabase inspect db index-stats` instead."),
  Command.withShortDescription("Removed: use `inspect db index-stats` instead"),
  // Removed: fails before any Management API call, so no flag changes what it calls.
  withPermissions({
    operations: [],
    noApiEffectFlags: ["db-url", "linked", "local", "project-ref"],
  }),
  Command.withHandler(() =>
    removedCommand("Use `supabase inspect db index-stats` instead.").pipe(
      withCommandTelemetry(),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(inspectDbCommandPath("total-index-size"))),
  Command.provide(telemetryStateLayer),
);
