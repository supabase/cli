import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackList } from "./list.handler.ts";

export const stackListCommand = Command.make("list").pipe(
  Command.withDescription("List persisted managed local Supabase stacks."),
  Command.withShortDescription("List managed local stacks"),
  Command.withHandler(() =>
    stackList().pipe(withCommandTelemetry({ flags: {} }), withJsonErrorHandling),
  ),
);
