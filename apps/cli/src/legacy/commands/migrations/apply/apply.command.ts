import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsApply } from "./apply.handler.ts";

export const legacyMigrationsApplyCommand = Command.make("apply").pipe(
  Command.withDescription(
    "Apply pending migration files to the local database.\n\n" +
      "This runs the files in supabase/migrations. It does not read supabase/schemas.\n" +
      "To try declaration edits without a migration yet, use schema apply.",
  ),
  Command.withShortDescription("Apply pending migrations locally"),
  Command.withExamples([
    {
      command: "supabase migrations apply",
      description: "Apply pending files to the local database",
    },
  ]),
  Command.withHandler(() =>
    legacyMigrationsApply().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "apply"])),
);
