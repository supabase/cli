import { Schema } from "effect";
import {
  actionability,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";
export class IssuesHealthUnsupportedError extends Schema.TaggedError<IssuesHealthUnsupportedError>()(
  "IssuesHealthUnsupportedError",
  { message: Schema.String },
) {
  get [ErrorActionabilityId]() {
    return actionability.invalidInput;
  }
}

export class IssuesOutputFlagUnsupportedError extends Schema.TaggedError<IssuesOutputFlagUnsupportedError>()(
  "IssuesOutputFlagUnsupportedError",
  { message: Schema.String },
) {
  get [ErrorActionabilityId]() {
    return actionability.invalidInput;
  }
}

export class IssuesHealthAuthorizationError extends Schema.TaggedError<IssuesHealthAuthorizationError>()(
  "IssuesHealthAuthorizationError",
  { status: Schema.Literals([401, 403]), message: Schema.String },
) {
  get [ErrorActionabilityId]() {
    return statusCodeActionability(this.status);
  }
}
