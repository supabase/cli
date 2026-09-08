import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class PostgresConfigGetNetworkError extends Data.TaggedError(
  "PostgresConfigGetNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class PostgresConfigGetUnexpectedStatusError extends Data.TaggedError(
  "PostgresConfigGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class PostgresConfigGetUnmarshalError extends Data.TaggedError(
  "PostgresConfigGetUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class PostgresConfigUpdateNetworkError extends Data.TaggedError(
  "PostgresConfigUpdateNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class PostgresConfigUpdateUnexpectedStatusError extends Data.TaggedError(
  "PostgresConfigUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class PostgresConfigUpdateUnmarshalError extends Data.TaggedError(
  "PostgresConfigUpdateUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class PostgresConfigUpdateSerializeError extends Data.TaggedError(
  "PostgresConfigUpdateSerializeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class PostgresConfigDeleteNetworkError extends Data.TaggedError(
  "PostgresConfigDeleteNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class PostgresConfigDeleteUnexpectedStatusError extends Data.TaggedError(
  "PostgresConfigDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class PostgresConfigDeleteUnmarshalError extends Data.TaggedError(
  "PostgresConfigDeleteUnmarshalError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Constructed only after a 200 status check when `parseJsonObject` fails —
    // an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class PostgresConfigDeleteSerializeError extends Data.TaggedError(
  "PostgresConfigDeleteSerializeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class PostgresConfigInvalidConfigValueError extends Data.TaggedError(
  "PostgresConfigInvalidConfigValueError",
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
