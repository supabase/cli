import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacySchemaApply } from "./apply.handler.ts";

export const legacySchemaApplyCommand = Command.make("apply").pipe(
  Command.withDescription(
    "Apply supabase/schemas to the local database without writing migration files.\n\n" +
      "Use this while iterating. When the local database looks right, run schema generate --name <feature>.\n\n" +
      "Only the local stack can be the target. Deploy remotes with migrations push.",
  ),
  Command.withShortDescription("Apply supabase/schemas to the local database"),
  Command.withExamples([
    { command: "supabase schema apply", description: "Apply declarations to the local database" },
  ]),
  Command.withHandler(() =>
    legacySchemaApply().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacySchemaRuntimeLayer(["schema", "apply"])),
);
