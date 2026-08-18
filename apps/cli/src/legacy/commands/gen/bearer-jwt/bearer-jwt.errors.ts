import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Extracts a display message from a thrown `cause`. Every `Effect.try` catch in this
 * command's handler/signing-key resolver wraps a function that only ever throws a real
 * `Error` (never a plain string/object) — but `catch` still types `cause` as `unknown`,
 * so the `instanceof` check stays. Pulled out here (rather than inlined at each call
 * site) so neither `bearer-jwt.handler.ts` nor `bearer-jwt.signing-key.ts` carries this
 * branch itself for coverage purposes — it's exercised directly by this file's own
 * unit tests instead.
 */
export function legacyBearerJwtErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `--role` is required, but required-flag validation runs only AFTER the
 * telemetry context is set up and later flushed. Enforced in the handler
 * (after the telemetry-flushing wrapper is already active) rather than at
 * parse time, so this failure still flushes `telemetry.json`. Established
 * message text `required flag(s) "role" not set`, with no usage block and
 * no `"Error: "` prefix.
 */
export class LegacyGenBearerJwtRoleRequiredError extends Data.TaggedError(
  "LegacyGenBearerJwtRoleRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `supabase/config.toml` itself is malformed. Mirrors `gen signing-key`'s own error shape. */
export class LegacyGenBearerJwtConfigParseError extends Data.TaggedError(
  "LegacyGenBearerJwtConfigParseError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** `[auth].signing_keys_path` is configured but the file could not be read. */
export class LegacyGenBearerJwtReadError extends Data.TaggedError("LegacyGenBearerJwtReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/** `[auth].signing_keys_path`'s file is not valid JSON / not a JWK array. */
export class LegacyGenBearerJwtDecodeError extends Data.TaggedError(
  "LegacyGenBearerJwtDecodeError",
)<{
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
export class LegacyGenBearerJwtKeyParseError extends Data.TaggedError(
  "LegacyGenBearerJwtKeyParseError",
)<{
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
export class LegacyGenBearerJwtKeyNotFoundError extends Data.TaggedError(
  "LegacyGenBearerJwtKeyNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Branch C: the TTY key picker given ZERO available keys quits immediately
 * without ever letting the user select anything. Established bare,
 * unwrapped message `"user aborted"`.
 */
export class LegacyGenBearerJwtKeyPickerAbortedError extends Data.TaggedError(
  "LegacyGenBearerJwtKeyPickerAbortedError",
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
export class LegacyGenBearerJwtPayloadError extends Data.TaggedError(
  "LegacyGenBearerJwtPayloadError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Unsupported key type/curve/algorithm, or a kty-vs-alg mismatch caught at
 * sign time. The message is `legacySignJwtWithJwk`'s own text, surfaced
 * verbatim, with no additional wrapping.
 */
export class LegacyGenBearerJwtSignError extends Data.TaggedError("LegacyGenBearerJwtSignError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
