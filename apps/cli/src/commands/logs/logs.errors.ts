import { Schema } from "effect";
import {
  actionability,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class LogsInputError extends Schema.TaggedError<LogsInputError>()("LogsInputError", {
  message: Schema.String,
}) {
  get [ErrorActionabilityId]() {
    return actionability.invalidInput;
  }
}

export class LogsApiError extends Schema.TaggedError<LogsApiError>()("LogsApiError", {
  message: Schema.String,
  status: Schema.Finite,
}) {
  get [ErrorActionabilityId]() {
    return statusCodeActionability(this.status);
  }
}

export class LogsClipboardError extends Schema.TaggedError<LogsClipboardError>()(
  "LogsClipboardError",
  {
    reason: Schema.Literals(["unavailable", "failed", "timeout"]),
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId]() {
    return this.reason === "unavailable"
      ? actionability.toolNotInstalled
      : actionability.toolFailed;
  }
}
