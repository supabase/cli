import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Creating the dated `<output-dir>/<YYYY-MM-DD>/` directory failed. Wraps the
 * failure as `failed to mkdir: %w`.
 */
export class InspectReportMkdirError extends Data.TaggedError("InspectReportMkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Writing one of the report CSV files failed. Wraps an open/write
 * failure as `failed to create output file: %w`. This port collects the COPY
 * bytes first and writes them afterwards, so a file-write failure surfaces here.
 */
export class InspectReportWriteError extends Data.TaggedError("InspectReportWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
