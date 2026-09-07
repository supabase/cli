import type { Effect, Option } from "effect";
import { Context } from "effect";

interface LegacyTelemetryOutputFormatShape {
  /**
   * Record the resolved telemetry `output_format`. Mirrors Go's `db query`, which
   * resolves its command-local `--output` (`json|table|csv`, defaulting to `table`
   * for humans and `json` for agents) and mirrors it onto the global
   * `utils.OutputFormat.Value` the `cli_command_executed` event reads
   * (`apps/cli-go/cmd/db.go:316-328` → `cmd/root.go:177-181`). Commands that don't
   * set this fall back to the default `-o`/`--output-format` derivation.
   */
  readonly set: (format: string) => Effect.Effect<void>;
  /** The recorded format, or `None` when the command never set one. */
  readonly get: Effect.Effect<Option.Option<string>>;
}

export class LegacyTelemetryOutputFormat extends Context.Service<
  LegacyTelemetryOutputFormat,
  LegacyTelemetryOutputFormatShape
>()("supabase/legacy/TelemetryOutputFormat") {}
