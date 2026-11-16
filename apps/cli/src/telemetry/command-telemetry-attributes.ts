import { Context, Effect } from "effect";
import type { StackRuntime } from "../command-internal/stack-runtime.ts";
import type { ServeEndReason } from "../shared/functions/serve.ts";
import {
  PropConfigFormat,
  PropConfigKey,
  PropEdgeRuntimeExitCode,
  PropOrioleDb,
  PropServeEndReason,
  PropStackRuntime,
} from "../shared/telemetry/event-catalog.ts";

/** Properties that code below a command handler adds to its `cli_command_executed` event. */
export interface CommandTelemetryAttributeValues {
  readonly [PropConfigKey]?: string;
  readonly [PropConfigFormat]?: "toml" | "json" | "jsonc";
  readonly [PropOrioleDb]?: boolean;
  readonly [PropStackRuntime]?: StackRuntime;
  readonly [PropServeEndReason]?: ServeEndReason;
  readonly [PropEdgeRuntimeExitCode]?: number;
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
