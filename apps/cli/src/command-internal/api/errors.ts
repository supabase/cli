import { Runtime, Schema } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class ApiCommandInputError extends Schema.TaggedError<ApiCommandInputError>()(
  "ApiCommandInputError",
  {
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorExitCode] = 2;
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class ApiCommandNetworkError extends Schema.TaggedError<ApiCommandNetworkError>()(
  "ApiCommandNetworkError",
  {
    message: Schema.String,
    decode: Schema.optionalKey(Schema.Boolean),
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ApiCommandStatusError extends Schema.TaggedError<ApiCommandStatusError>()(
  "ApiCommandStatusError",
  {
    status: Schema.Finite,
    body: Schema.String,
    message: Schema.String,
    entitlement: Schema.optionalKey(
      Schema.Struct({ feature: Schema.String, upgrade_url: Schema.String }),
    ),
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class ApiCommandWaitError extends Schema.TaggedError<ApiCommandWaitError>()(
  "ApiCommandWaitError",
  {
    message: Schema.String,
    suggestion: Schema.String,
    reason: Schema.Literals(["failed", "timeout", "invalid_response"]),
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}
