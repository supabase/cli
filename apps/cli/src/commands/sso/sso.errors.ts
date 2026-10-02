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
 * SAML is entitlement-gated: `upgradeSuggested` lets telemetry distinguish
 * plan-gated failures from ordinary API failures without parsing message text.
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

// Shared across show/update/remove. Message: `identity provider ID %q is not a UUID`.
export class SsoInvalidUuidError extends Data.TaggedError("SsoInvalidUuidError")<{
  readonly providerId: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// Shared across list/show. Reachable when an `attribute_mapping` `default`
// value can't be encoded (e.g. an array with a nil element).
export class SsoTomlEncodeError extends Data.TaggedError("SsoTomlEncodeError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

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

// Emulates pflag's rejection of a bare value-taking flag as the final argv
// token, a case the Effect parser accepts. Shared by add + update; the
// message matches pflag's template.
export class SsoFlagNeedsArgumentError extends Data.TaggedError("SsoFlagNeedsArgumentError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Emulates pflag's rejection of an invalid flag value in cases the Effect
// parser accepts: a later occurrence of a repeated flag (the parser resolves
// repeats first-wins and never validates the rest), or a boolean literal
// outside pflag's accepted set. Shared by add + update; the message matches
// pflag's template.
export class SsoInvalidFlagValueError extends Data.TaggedError("SsoInvalidFlagValueError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Fires when a required flag's own token is consumed as another flag's
// value, so it's never marked present. The message text is a stable output
// contract.
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
    // Fires only for the user-supplied `--metadata-url` endpoint, never a
    // Supabase service, so failures here are user input like the sibling errors.
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

// Fires when a flag token is consumed as another flag's value, shifting a
// value into the positional list so arg-count validation rejects it first.
// The message text is a stable output contract.
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
 * Fired when the reconciled profile's token lookup finds nothing, at first
 * use — after required/mutex/workdir validation runs.
 */
export class SsoAccessTokenError extends Data.TaggedError("SsoAccessTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}
