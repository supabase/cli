import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `supabase config push`, one per Go error path
 * (`pkg/config/updater.go`, `internal/config/push/push.go`). Messages match the
 * Go strings verbatim.
 *
 * Two shapes recur:
 *   - **network** errors carry `{ message }` (Go `errors.Errorf("failed to … : %w", err)`).
 *   - **status** errors carry `{ status, body, message }` (Go
 *     `errors.Errorf("unexpected status %d: %s", code, body)`); all read/update
 *     paths share the generic `unexpected status <code>: <body>` text except
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
 * failure (`SchemaError` / `HttpBodyError` folded in by `mapLegacyHttpError`).
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
    return statusCodeActionability(this.status);
  }
}

// --- api --------------------------------------------------------------------

export class LegacyConfigPushApiReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushApiReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushApiReadStatusError extends Data.TaggedError(
  "LegacyConfigPushApiReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
  }
}

// --- db.settings ------------------------------------------------------------

export class LegacyConfigPushDbReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushDbReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushDbReadStatusError extends Data.TaggedError(
  "LegacyConfigPushDbReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
  }
}

// --- db.network_restrictions ------------------------------------------------

export class LegacyConfigPushNetworkRestrictionsReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushNetworkRestrictionsReadStatusError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
  }
}

// --- db.ssl_enforcement -----------------------------------------------------

export class LegacyConfigPushSslEnforcementReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushSslEnforcementReadStatusError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
  }
}

// --- auth -------------------------------------------------------------------

export class LegacyConfigPushAuthReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushAuthReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushAuthReadStatusError extends Data.TaggedError(
  "LegacyConfigPushAuthReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
  }
}

// --- storage ----------------------------------------------------------------

export class LegacyConfigPushStorageReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushStorageReadNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}
export class LegacyConfigPushStorageReadStatusError extends Data.TaggedError(
  "LegacyConfigPushStorageReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
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
    return statusCodeActionability(this.status);
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
    return statusCodeActionability(this.status);
  }
}
