import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** Creating the dated `<output-dir>/<YYYY-MM-DD>/` directory failed. */
export class InspectReportMkdirError extends Data.TaggedError("InspectReportMkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Writing one of the report CSV files failed. The COPY bytes are collected first and written
 * afterwards, so a file-write failure surfaces separately from a query failure.
 */
export class InspectReportWriteError extends Data.TaggedError("InspectReportWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
