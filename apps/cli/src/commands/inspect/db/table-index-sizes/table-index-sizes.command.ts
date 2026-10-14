import { Command } from "effect/cli";
import { removedCommand } from "../../../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../telemetry/telemetry-state.layer.ts";
import { INSPECT_DB_FLAGS } from "../inspect-db-command.ts";
import { inspectDbCommandPath } from "../db.layers.ts";

export const inspectDbTableIndexSizesCommand = Command.make(
  "table-index-sizes",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Removed: use `supabase inspect db table-stats` instead."),
  Command.withShortDescription("Removed: use `inspect db table-stats` instead"),
  Command.withHandler(() =>
    removedCommand("Use `supabase inspect db table-stats` instead.").pipe(
      withCommandTelemetry(),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(inspectDbCommandPath("table-index-sizes"))),
  Command.provide(telemetryStateLayer),
);
