import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Creating the dated `<output-dir>/<YYYY-MM-DD>/` directory failed. Wraps the
 * failure as `failed to mkdir: %w`.
 */
export class LegacyInspectReportMkdirError extends Data.TaggedError(
  "LegacyInspectReportMkdirError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Writing one of the report CSV files failed. Wraps an open/write
 * failure as `failed to create output file: %w`. This port collects the COPY
 * bytes first and writes them afterwards, so a file-write failure surfaces here.
 */
export class LegacyInspectReportWriteError extends Data.TaggedError(
  "LegacyInspectReportWriteError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
