import { Schema } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class WarehouseEnableInputError extends Schema.TaggedError<WarehouseEnableInputError>()(
  "WarehouseEnableInputError",
  { message: Schema.String },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class WarehouseEnableNetworkError extends Schema.TaggedError<WarehouseEnableNetworkError>()(
  "WarehouseEnableNetworkError",
  { message: Schema.String, decode: Schema.optionalKey(Schema.Boolean) },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class WarehouseEnableStatusError extends Schema.TaggedError<WarehouseEnableStatusError>()(
  "WarehouseEnableStatusError",
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

export class WarehouseEnableIncompleteError extends Schema.TaggedError<WarehouseEnableIncompleteError>()(
  "WarehouseEnableIncompleteError",
  { message: Schema.String, suggestion: Schema.String },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}

export class WarehouseEnableTimeoutError extends Schema.TaggedError<WarehouseEnableTimeoutError>()(
  "WarehouseEnableTimeoutError",
  { message: Schema.String, suggestion: Schema.String },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "operation_timeout" };
  }
}
