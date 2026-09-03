import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `supabase config push`.
 *
 * Two shapes recur:
 *   - **network** errors carry `{ message }` (and sometimes `decode` — a 200
 *     response the client could not decode, reclassified as an API-response
 *     problem rather than a transport one).
 *   - **status** errors carry `{ status, body, message }`; every update path
 *     shares the generic `unexpected status <code>: <body>` text except
 *     list-addons and enable-webhook, which keep their own prefixes.
 *
 * Project-ref / credential errors come from the shared resolver + credential
 * services and are intentionally not redeclared here.
 */

interface NetworkErrorArgs {
  readonly message: string;
}

/**
 * A network-error shape that may instead represent a 200-response body decode
 * failure (`SchemaError` folded in by `mapLegacyHttpError`).
 * `decode: true` reclassifies the failure as an API-response problem rather
 * than a transport/network problem.
 */
interface DecodableNetworkErrorArgs {
  readonly message: string;
  readonly decode?: boolean;
}

interface StatusErrorArgs {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}

/** TOML parse failure (rewraps the packages/config parse error). Aborts before any network call. */
export class LegacyConfigPushLoadConfigError extends Data.TaggedError(
  "LegacyConfigPushLoadConfigError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

// --- cost matrix (list addons) ---------------------------------------------

export class LegacyConfigPushListAddonsNetworkError extends Data.TaggedError(
  "LegacyConfigPushListAddonsNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    return actionability.externalNetwork;
  }
}

export class LegacyConfigPushListAddonsStatusError extends Data.TaggedError(
  "LegacyConfigPushListAddonsStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- effective project config read (GET /v2/projects/{ref}/config) --------

/**
 * Transport failure or undecodable response reading the project's effective
 * configuration. `decode === true` reclassifies a 200 response the client
 * could not decode as an API-response problem rather than a transport one —
 * same rule as `diff/diff.errors.ts`'s `LegacyConfigDiffReadNetworkError`.
 */
export class LegacyConfigPushConfigReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushConfigReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/**
 * The effective project config read returned a non-200 status.
 * `/v2/projects/{ref}/config` names a user-selected resource, so a 404 means
 * "wrong project ref" — user-actionable, not an external-service problem
 * (same rule as `diff/diff.errors.ts`'s `LegacyConfigDiffReadStatusError`).
 */
export class LegacyConfigPushConfigReadStatusError extends Data.TaggedError(
  "LegacyConfigPushConfigReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- api --------------------------------------------------------------------

export class LegacyConfigPushApiUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushApiUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushApiUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushApiUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- db.settings ------------------------------------------------------------

export class LegacyConfigPushDbUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushDbUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushDbUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushDbUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- db.network_restrictions ------------------------------------------------

export class LegacyConfigPushNetworkRestrictionsUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushNetworkRestrictionsUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- db.ssl_enforcement -----------------------------------------------------

export class LegacyConfigPushSslEnforcementUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushSslEnforcementUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- auth -------------------------------------------------------------------

export class LegacyConfigPushAuthUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushAuthUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushAuthUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushAuthUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- storage ----------------------------------------------------------------

export class LegacyConfigPushStorageUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushStorageUpdateNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushStorageUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushStorageUpdateStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- experimental.webhooks --------------------------------------------------

export class LegacyConfigPushEnableWebhookNetworkError extends Data.TaggedError(
  "LegacyConfigPushEnableWebhookNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushEnableWebhookStatusError extends Data.TaggedError(
  "LegacyConfigPushEnableWebhookStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
