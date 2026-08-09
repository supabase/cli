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
 * Go marks `--role` required (`cmd/gen.go:175`), but cobra's `ValidateRequiredFlags`
 * runs only AFTER `PersistentPreRunE` — which is where telemetry gets set up and later
 * flushed (`cobra@v1.10.2/command.go:985,1007`). Enforced in the handler (after the
 * telemetry-flushing wrapper is already active) rather than at parse time, so this
 * failure still flushes `telemetry.json` like Go does. Byte-matches cobra's exact
 * `required flag(s) "role" not set` wording, with no usage block (`SilenceUsage` is
 * already set by the time `ValidateRequiredFlags` runs) and no `"Error: "` prefix
 * (`cmd/root.go`'s `SilenceErrors: true` means cobra never prints its own prefix;
 * `recoverAndExit` prints the bare message) — verified against the real binary.
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
 * Go's `getSigningKey` Branch A (`bearerjwt.go:46-50`): the pasted stdin JWK is not
 * valid JSON. Byte-matches `"failed to parse JWK: %w"`.
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
 * Go's `getSigningKey` Branch B (`bearerjwt.go:67`): the entered kid matched no
 * configured signing key. Byte-matches `"signing key not found: %s"`.
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
 * Go's `getSigningKey` Branch C (`bearerjwt.go:70-79`): the TTY key picker
 * (`utils.PromptChoice`, `internal/utils/prompt.go:120-140`) given ZERO available
 * keys quits immediately without ever letting the user select anything. Byte-matches
 * Go's bare, unwrapped `"user aborted"` — `getSigningKey` returns `PromptChoice`'s
 * error as-is, with no additional wrapping.
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
 * Go's `parseClaims` payload merge (`cmd/gen.go:209-211`). Byte-matches
 * `"failed to parse payload: %w"`.
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
 * Go's `config.GenerateAsymmetricJWT` (`pkg/config/apikeys.go:88-113`) — unsupported
 * key type/curve/algorithm, or a kty-vs-alg mismatch caught at sign time. The message
 * is `legacySignJwtWithJwk`'s own text, surfaced verbatim (Go's `bearerjwt.Run`
 * returns this error bare, with no additional wrapping — `bearerjwt.go:27-30`).
 */
export class LegacyGenBearerJwtSignError extends Data.TaggedError("LegacyGenBearerJwtSignError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
