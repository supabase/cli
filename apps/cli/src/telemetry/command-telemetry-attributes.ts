import { Context, Effect } from "effect";
import type { CliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import type { StackRuntime } from "../command-internal/stack-runtime.ts";
import type { ServeEndReason } from "../shared/functions/serve.ts";
import {
  PropConfigFormat,
  PropConfigKey,
  PropConvertMovedCommentCount,
  PropConvertReason,
  PropConvertTarget,
  PropEdgeRuntimeExitCode,
  PropOrioleDb,
  PropServeEndReason,
  PropSkillTopic,
  PropStackRuntime,
} from "../shared/telemetry/event-catalog.ts";

export const CONVERT_REASONS = [
  "editor",
  "third-party-tool",
  "older-cli",
  "ci-or-deploy",
  "ai-agent",
  "preference",
  "other",
] as const;

export type ConvertReason = (typeof CONVERT_REASONS)[number];

/** Properties that code below a command handler adds to its `cli_command_executed` event. */
export interface CommandTelemetryAttributeValues {
  readonly processControlledFailure?: CliErrorActionability;
  readonly [PropConvertTarget]?: "toml" | "jsonc";
  readonly [PropConvertReason]?: ConvertReason;
  readonly [PropConvertMovedCommentCount]?: number;
  readonly [PropConfigKey]?: string;
  readonly [PropConfigFormat]?: "toml" | "json" | "jsonc";
  readonly [PropOrioleDb]?: boolean;
  readonly [PropStackRuntime]?: StackRuntime;
  readonly [PropServeEndReason]?: ServeEndReason;
  readonly [PropEdgeRuntimeExitCode]?: number;
  readonly [PropSkillTopic]?: string;
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
