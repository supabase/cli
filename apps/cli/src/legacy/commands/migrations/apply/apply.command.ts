import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsApply } from "./apply.handler.ts";

export const legacyMigrationsApplyCommand = Command.make("apply").pipe(
  Command.withDescription("Apply exact pending migration files to the local database."),
  Command.withShortDescription("Apply pending migrations locally"),
  Command.withHandler(() =>
    legacyMigrationsApply().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "apply"])),
);
