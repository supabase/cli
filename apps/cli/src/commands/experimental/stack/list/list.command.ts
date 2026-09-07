import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackList } from "./list.handler.ts";

export const legacyExperimentalStackListCommand = Command.make("list").pipe(
  Command.withDescription("List persisted managed local Supabase stacks."),
  Command.withShortDescription("List managed local stacks"),
  Command.withHandler(() =>
    legacyExperimentalStackList().pipe(
      withLegacyCommandInstrumentation({ flags: {}, config: {} }),
      withJsonErrorHandling,
    ),
  ),
);
