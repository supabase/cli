import type { Effect, Option } from "effect";
import { Context } from "effect";

interface TelemetryOutputFormatShape {
  /**
   * Records the resolved telemetry `output_format`, e.g. for `db query`, which resolves its
   * command-local `--output` (`json|table|csv`, defaulting to `table` for humans and `json` for
   * agents) and needs that value reflected in the `cli_command_executed` event. Commands that
   * don't set this fall back to the default `-o`/`--output-format` derivation.
   */
  readonly set: (format: string) => Effect.Effect<void>;
  /** The recorded format, or `None` when the command never set one. */
  readonly get: Effect.Effect<Option.Option<string>>;
}

export class TelemetryOutputFormat extends Context.Service<
  TelemetryOutputFormat,
  TelemetryOutputFormatShape
>()("supabase/cli/TelemetryOutputFormat") {}
