import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsApply } from "./apply.handler.ts";

export const migrationsApplyCommand = Command.make("apply").pipe(
  Command.withDescription("Apply exact pending migration files to the local database."),
  Command.withShortDescription("Apply pending migrations locally"),
  Command.withHandler(() =>
    migrationsApply().pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "apply"])),
);
