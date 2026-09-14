import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Extracts a display message from a thrown `cause`. Every catch site here
 * only ever throws a real `Error`, but `catch` still types `cause` as
 * `unknown`, hence the `instanceof` check.
 */
export function bearerJwtErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `--role` is required, but enforced in the handler rather than at parse
 * time, so a missing value still flushes `telemetry.json`. Message text is
 * `required flag(s) "role" not set`, with no usage block or `"Error: "` prefix.
 */
export class GenBearerJwtRoleRequiredError extends Data.TaggedError(
  "GenBearerJwtRoleRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `supabase/config.toml` itself is malformed. Mirrors `gen signing-key`'s own error shape. */
export class GenBearerJwtConfigParseError extends Data.TaggedError("GenBearerJwtConfigParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** `[auth].signing_keys_path` is configured but the file could not be read. */
export class GenBearerJwtReadError extends Data.TaggedError("GenBearerJwtReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/** `[auth].signing_keys_path`'s file is not valid JSON / not a JWK array. */
export class GenBearerJwtDecodeError extends Data.TaggedError("GenBearerJwtDecodeError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Branch A: the pasted stdin JWK is not valid JSON. Established message
 * `"failed to parse JWK: %w"`.
 */
export class GenBearerJwtKeyParseError extends Data.TaggedError("GenBearerJwtKeyParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Branch B: the entered kid matched no configured signing key. Established
 * message `"signing key not found: %s"`.
 */
export class GenBearerJwtKeyNotFoundError extends Data.TaggedError("GenBearerJwtKeyNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Branch C: the TTY key picker given zero available keys quits immediately
 * without ever letting the user select anything. Message is the bare,
 * unwrapped `"user aborted"`.
 */
export class GenBearerJwtKeyPickerAbortedError extends Data.TaggedError(
  "GenBearerJwtKeyPickerAbortedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/**
 * `--payload` merge failure. Established message `"failed to parse payload: %w"`.
 */
export class GenBearerJwtPayloadError extends Data.TaggedError("GenBearerJwtPayloadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Unsupported key type/curve/algorithm, or a kty-vs-alg mismatch caught at
 * sign time. The message is `signJwtWithJwk`'s own text, surfaced
 * verbatim, with no additional wrapping.
 */
export class GenBearerJwtSignError extends Data.TaggedError("GenBearerJwtSignError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
