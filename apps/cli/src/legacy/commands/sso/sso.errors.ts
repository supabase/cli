import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  planLimitGatedActionability,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";
import type { LegacySsoFileErrorReason } from "./sso.saml.ts";

function ssoFileActionability(reason: LegacySsoFileErrorReason): CliErrorActionabilityDeclaration {
  if (reason === "not_found") {
    return { ...actionability.provideFlags, fingerprint_suffix: "not_found" };
  }
  if (reason === "permission") {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
  if (reason === "invalid_content") {
    return { ...actionability.invalidInput, fingerprint_suffix: "invalid_content" };
  }
  if (reason === "invalid_url") {
    return { ...actionability.provideFlags, fingerprint_suffix: "invalid_url" };
  }
  return { ...actionability.unknown, fingerprint_suffix: "platform_error" };
}

/**
 * The SAML feature is entitlement-gated: handlers thread the typed result of
 * `legacySuggestUpgrade` (`upgradeSuggested`) into these errors so telemetry
 * can distinguish plan-gated failures from ordinary API failures without
 * sniffing message text.
 */
const samlDisabledActionability = (
  upgradeSuggested: boolean | undefined,
): CliErrorActionabilityDeclaration =>
  upgradeSuggested === true
    ? planLimitGatedActionability
    : { ...actionability.invalidConfig, fingerprint_suffix: "saml_disabled" };

const gatedNotFoundActionability = (
  upgradeSuggested: boolean | undefined,
): CliErrorActionabilityDeclaration =>
  upgradeSuggested === true ? planLimitGatedActionability : actionability.invalidInput;

// Shared across show / update / remove: invalid identity provider ID.
// Message is a short, directly user-actionable string —
// `identity provider ID %q is not a UUID` — tested in e2e.
export class LegacySsoInvalidUuidError extends Data.TaggedError("LegacySsoInvalidUuidError")<{
  readonly providerId: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// Shared across list / show: TOML encode failure ("failed to output toml: %w")
// — reachable when an `attribute_mapping` `default` value cannot be encoded
// (e.g. an array with a nil element).
export class LegacySsoTomlEncodeError extends Data.TaggedError("LegacySsoTomlEncodeError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

// `sso list`
export class LegacySsoListNetworkError extends Data.TaggedError("LegacySsoListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacySsoListSamlDisabledError extends Data.TaggedError(
  "LegacySsoListSamlDisabledError",
)<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return samlDisabledActionability(this.upgradeSuggested);
  }
}

export class LegacySsoListUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

// `sso add`
export class LegacySsoAddNetworkError extends Data.TaggedError("LegacySsoAddNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySsoAddSamlDisabledError extends Data.TaggedError(
  "LegacySsoAddSamlDisabledError",
)<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return samlDisabledActionability(this.upgradeSuggested);
  }
}

export class LegacySsoAddUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoAddUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

export class LegacySsoAddMetadataFileError extends Data.TaggedError(
  "LegacySsoAddMetadataFileError",
)<{
  readonly message: string;
  readonly reason: LegacySsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class LegacySsoAddAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoAddAttributeMappingFileError",
)<{
  readonly message: string;
  readonly reason: LegacySsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class LegacySsoMutexFlagError extends Data.TaggedError("LegacySsoMutexFlagError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// pflag's `ValueRequiredError` (`errors.go:63-78`), emulated for the case the
// Effect parser accepts but pflag rejects: a bare value-taking flag as the
// final argv token (`sso update <id> --domains`). pflag fails `ParseFlags`
// (cobra `command.go:919`) before `ValidateArgs`, every hook, and `RunE`, so
// Go exits without any API call. Shared across add + update; message
// byte-matches pflag's template.
export class LegacySsoFlagNeedsArgumentError extends Data.TaggedError(
  "LegacySsoFlagNeedsArgumentError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// pflag's `InvalidValueError` (`errors.go:32-48`, raised when a flag's
// `Value.Set` rejects an occurrence), emulated for values the Effect parser
// accepts but pflag does not: a repeated flag whose later occurrence is
// invalid (the Effect parser resolves repeats first-wins and never validates
// the rest — `--type saml --type bogus`), and boolean literals outside Go's
// `strconv.ParseBool` set (`--skip-url-validation=yes`). pflag fails
// `ParseFlags` (cobra `command.go:919`) before `ValidateArgs`, every hook,
// and `RunE`, so Go exits without any API call. Shared across add + update;
// message byte-matches pflag's template.
export class LegacySsoInvalidFlagValueError extends Data.TaggedError(
  "LegacySsoInvalidFlagValueError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Emulates an edge case the flag parser cannot see directly: a required
// flag's own token gets consumed as another flag's value, so the flag is
// never marked as present and validation fails before any request is made.
// Message text is an established output contract.
export class LegacySsoAddRequiredFlagError extends Data.TaggedError(
  "LegacySsoAddRequiredFlagError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Shared across add + update — metadata URL validation.
export class LegacySsoMetadataUrlInvalidError extends Data.TaggedError(
  "LegacySsoMetadataUrlInvalidError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySsoMetadataUrlNetworkError extends Data.TaggedError(
  "LegacySsoMetadataUrlNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Fired only during preflight validation of the USER-SUPPLIED
    // `--metadata-url` (a third-party SAML IDP endpoint), never a Supabase
    // service — a bad URL that times out / non-200s / is too large is user
    // input, like its `MetadataUrlInvalid` / `NonUtf8` siblings.
    return actionability.provideFlags;
  }
}

export class LegacySsoMetadataUrlNonUtf8Error extends Data.TaggedError(
  "LegacySsoMetadataUrlNonUtf8Error",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// `sso show`
export class LegacySsoShowNetworkError extends Data.TaggedError("LegacySsoShowNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacySsoShowNotFoundError extends Data.TaggedError("LegacySsoShowNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacySsoShowUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoShowUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacySsoShowEnvNotSupportedError extends Data.TaggedError(
  "LegacySsoShowEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// `sso update`
// Emulates an edge case the flag parser cannot see directly: a flag token
// gets consumed as another flag's value, shifting what the parser read as a
// flag's value into the positional list, so the arg count is rejected before
// any hook or request. Message text is an established output contract.
export class LegacySsoUpdateArityError extends Data.TaggedError("LegacySsoUpdateArityError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySsoUpdateNetworkError extends Data.TaggedError("LegacySsoUpdateNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacySsoUpdateNotFoundError extends Data.TaggedError("LegacySsoUpdateNotFoundError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return gatedNotFoundActionability(this.upgradeSuggested);
  }
}

export class LegacySsoUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, {
      upgradeSuggested: this.upgradeSuggested,
      notFoundIsInvalidInput: true,
    });
  }
}

export class LegacySsoUpdateMetadataFileError extends Data.TaggedError(
  "LegacySsoUpdateMetadataFileError",
)<{
  readonly message: string;
  readonly reason: LegacySsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class LegacySsoUpdateAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoUpdateAttributeMappingFileError",
)<{
  readonly message: string;
  readonly reason: LegacySsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

// `sso remove`
export class LegacySsoRemoveNetworkError extends Data.TaggedError("LegacySsoRemoveNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacySsoRemoveNotFoundError extends Data.TaggedError("LegacySsoRemoveNotFoundError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return gatedNotFoundActionability(this.upgradeSuggested);
  }
}

export class LegacySsoRemoveUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoRemoveUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

/**
 * Token gate: fired when the reconciled profile's token lookup finds
 * nothing — at first client use, AFTER required/mutex/workdir validation
 * (PR #5974 review round 10).
 */
export class LegacySsoAccessTokenError extends Data.TaggedError("LegacySsoAccessTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}
