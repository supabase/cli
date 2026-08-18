import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class LegacyPostgresConfigGetNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigGetNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacyPostgresConfigGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyPostgresConfigGetUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigGetUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class LegacyPostgresConfigUpdateNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacyPostgresConfigUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyPostgresConfigUpdateUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class LegacyPostgresConfigUpdateSerializeError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateSerializeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyPostgresConfigDeleteNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacyPostgresConfigDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyPostgresConfigDeleteUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class LegacyPostgresConfigDeleteSerializeError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteSerializeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyPostgresConfigInvalidConfigValueError extends Data.TaggedError(
  "LegacyPostgresConfigInvalidConfigValueError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({
      input: args.input,
      message: `expected config value in key:value format, received: '${args.input}'`,
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
