import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** The `-o/--output` flag was passed; report commands only support `--output-format`. */
export class InspectReportOutputFlagUnsupportedError extends Data.TaggedError(
  "InspectReportOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
