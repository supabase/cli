import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  planLimitGatedActionability,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

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

// Shared across show / update / remove: Go's `uuid.Parse` failure.
// Message intentionally diverges from Go's verbose `failed to parse provider ID: invalid UUID …`
// — the legacy/sso port consolidates to a single short string `identity provider ID %q is not a UUID`
// that's directly user-actionable and tested in e2e.
export class LegacySsoInvalidUuidError extends Data.TaggedError("LegacySsoInvalidUuidError")<{
  readonly providerId: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// `sso list`
export class LegacySsoListNetworkError extends Data.TaggedError("LegacySsoListNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySsoAddAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoAddAttributeMappingFileError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySsoMutexFlagError extends Data.TaggedError("LegacySsoMutexFlagError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
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
    return actionability.externalNetwork;
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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
export class LegacySsoUpdateNetworkError extends Data.TaggedError("LegacySsoUpdateNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

export class LegacySsoUpdateMetadataFileError extends Data.TaggedError(
  "LegacySsoUpdateMetadataFileError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySsoUpdateAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoUpdateAttributeMappingFileError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// `sso remove`
export class LegacySsoRemoveNetworkError extends Data.TaggedError("LegacySsoRemoveNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
