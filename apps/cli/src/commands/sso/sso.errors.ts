import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  planLimitGatedActionability,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";
import type { SsoFileErrorReason } from "./sso.saml.ts";

function ssoFileActionability(reason: SsoFileErrorReason): CliErrorActionabilityDeclaration {
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
 * `suggestUpgrade` (`upgradeSuggested`) into these errors so telemetry
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
export class SsoInvalidUuidError extends Data.TaggedError("SsoInvalidUuidError")<{
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
export class SsoTomlEncodeError extends Data.TaggedError("SsoTomlEncodeError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

// `sso list`
export class SsoListNetworkError extends Data.TaggedError("SsoListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SsoListSamlDisabledError extends Data.TaggedError("SsoListSamlDisabledError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return samlDisabledActionability(this.upgradeSuggested);
  }
}

export class SsoListUnexpectedStatusError extends Data.TaggedError("SsoListUnexpectedStatusError")<{
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
export class SsoAddNetworkError extends Data.TaggedError("SsoAddNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class SsoAddSamlDisabledError extends Data.TaggedError("SsoAddSamlDisabledError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return samlDisabledActionability(this.upgradeSuggested);
  }
}

export class SsoAddUnexpectedStatusError extends Data.TaggedError("SsoAddUnexpectedStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

export class SsoAddMetadataFileError extends Data.TaggedError("SsoAddMetadataFileError")<{
  readonly message: string;
  readonly reason: SsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class SsoAddAttributeMappingFileError extends Data.TaggedError(
  "SsoAddAttributeMappingFileError",
)<{
  readonly message: string;
  readonly reason: SsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class SsoMutexFlagError extends Data.TaggedError("SsoMutexFlagError")<{
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
export class SsoFlagNeedsArgumentError extends Data.TaggedError("SsoFlagNeedsArgumentError")<{
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
export class SsoInvalidFlagValueError extends Data.TaggedError("SsoInvalidFlagValueError")<{
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
export class SsoAddRequiredFlagError extends Data.TaggedError("SsoAddRequiredFlagError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Shared across add + update — metadata URL validation.
export class SsoMetadataUrlInvalidError extends Data.TaggedError("SsoMetadataUrlInvalidError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class SsoMetadataUrlNetworkError extends Data.TaggedError("SsoMetadataUrlNetworkError")<{
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

export class SsoMetadataUrlNonUtf8Error extends Data.TaggedError("SsoMetadataUrlNonUtf8Error")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// `sso show`
export class SsoShowNetworkError extends Data.TaggedError("SsoShowNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SsoShowNotFoundError extends Data.TaggedError("SsoShowNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SsoShowUnexpectedStatusError extends Data.TaggedError("SsoShowUnexpectedStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class SsoShowEnvNotSupportedError extends Data.TaggedError("SsoShowEnvNotSupportedError")<{
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
export class SsoUpdateArityError extends Data.TaggedError("SsoUpdateArityError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class SsoUpdateNetworkError extends Data.TaggedError("SsoUpdateNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SsoUpdateNotFoundError extends Data.TaggedError("SsoUpdateNotFoundError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return gatedNotFoundActionability(this.upgradeSuggested);
  }
}

export class SsoUpdateUnexpectedStatusError extends Data.TaggedError(
  "SsoUpdateUnexpectedStatusError",
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

export class SsoUpdateMetadataFileError extends Data.TaggedError("SsoUpdateMetadataFileError")<{
  readonly message: string;
  readonly reason: SsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

export class SsoUpdateAttributeMappingFileError extends Data.TaggedError(
  "SsoUpdateAttributeMappingFileError",
)<{
  readonly message: string;
  readonly reason: SsoFileErrorReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return ssoFileActionability(this.reason);
  }
}

// `sso remove`
export class SsoRemoveNetworkError extends Data.TaggedError("SsoRemoveNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SsoRemoveNotFoundError extends Data.TaggedError("SsoRemoveNotFoundError")<{
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return gatedNotFoundActionability(this.upgradeSuggested);
  }
}

export class SsoRemoveUnexpectedStatusError extends Data.TaggedError(
  "SsoRemoveUnexpectedStatusError",
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
export class SsoAccessTokenError extends Data.TaggedError("SsoAccessTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}
