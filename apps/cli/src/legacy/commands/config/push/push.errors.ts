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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
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
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}
export class LegacyConfigPushEnableWebhookStatusError extends Data.TaggedError(
  "LegacyConfigPushEnableWebhookStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}
