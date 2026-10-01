import { Context, Effect } from "effect";
import { PropOrioleDb } from "../shared/telemetry/event-catalog.ts";

/** Properties that code below a command handler adds to its `cli_command_executed` event. */
export interface CommandTelemetryAttributeValues {
  readonly [PropOrioleDb]?: boolean;
}

/** Command-scoped attribute sink; `withCommandTelemetry` provides one, otherwise records are dropped. */
export const CommandTelemetryAttributes = Context.Reference<{
  readonly record: (values: CommandTelemetryAttributeValues) => Effect.Effect<void>;
}>("supabase/cli/CommandTelemetryAttributes", {
  defaultValue: () => ({ record: () => Effect.void }),
});

/** Records attributes on the enclosing command's `cli_command_executed` event. */
export const recordCommandTelemetry = (
  values: CommandTelemetryAttributeValues,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const attributes = yield* CommandTelemetryAttributes;
    yield* attributes.record(values);
  });
