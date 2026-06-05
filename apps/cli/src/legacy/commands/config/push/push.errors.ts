import { Data } from "effect";

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
)<NetworkErrorArgs> {}

/**
 * A `[remotes.<name>]` block matches the target project ref. Faithful subset
 * merging (Go's `mergeRemoteConfig`) is not yet implemented, and applying the
 * decoded remote section verbatim would silently reset every field the block
 * does not override to its schema default — overwriting remote config the user
 * never intended to touch. We abort instead of corrupting the remote. Aborts
 * before any network call.
 */
export class LegacyConfigPushUnsupportedRemoteError extends Data.TaggedError(
  "LegacyConfigPushUnsupportedRemoteError",
)<NetworkErrorArgs> {}

// --- cost matrix (list addons) ---------------------------------------------

export class LegacyConfigPushListAddonsNetworkError extends Data.TaggedError(
  "LegacyConfigPushListAddonsNetworkError",
)<NetworkErrorArgs> {}

export class LegacyConfigPushListAddonsStatusError extends Data.TaggedError(
  "LegacyConfigPushListAddonsStatusError",
)<StatusErrorArgs> {}

// --- api --------------------------------------------------------------------

export class LegacyConfigPushApiReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushApiReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushApiReadStatusError extends Data.TaggedError(
  "LegacyConfigPushApiReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushApiUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushApiUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushApiUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushApiUpdateStatusError",
)<StatusErrorArgs> {}

// --- db.settings ------------------------------------------------------------

export class LegacyConfigPushDbReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushDbReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushDbReadStatusError extends Data.TaggedError(
  "LegacyConfigPushDbReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushDbUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushDbUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushDbUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushDbUpdateStatusError",
)<StatusErrorArgs> {}

// --- db.network_restrictions ------------------------------------------------

export class LegacyConfigPushNetworkRestrictionsReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushNetworkRestrictionsReadStatusError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushNetworkRestrictionsUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushNetworkRestrictionsUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushNetworkRestrictionsUpdateStatusError",
)<StatusErrorArgs> {}

// --- db.ssl_enforcement -----------------------------------------------------

export class LegacyConfigPushSslEnforcementReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushSslEnforcementReadStatusError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushSslEnforcementUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushSslEnforcementUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushSslEnforcementUpdateStatusError",
)<StatusErrorArgs> {}

// --- auth -------------------------------------------------------------------

export class LegacyConfigPushAuthReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushAuthReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushAuthReadStatusError extends Data.TaggedError(
  "LegacyConfigPushAuthReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushAuthUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushAuthUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushAuthUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushAuthUpdateStatusError",
)<StatusErrorArgs> {}

// --- storage ----------------------------------------------------------------

export class LegacyConfigPushStorageReadNetworkError extends Data.TaggedError(
  "LegacyConfigPushStorageReadNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushStorageReadStatusError extends Data.TaggedError(
  "LegacyConfigPushStorageReadStatusError",
)<StatusErrorArgs> {}
export class LegacyConfigPushStorageUpdateNetworkError extends Data.TaggedError(
  "LegacyConfigPushStorageUpdateNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushStorageUpdateStatusError extends Data.TaggedError(
  "LegacyConfigPushStorageUpdateStatusError",
)<StatusErrorArgs> {}

// --- experimental.webhooks --------------------------------------------------

export class LegacyConfigPushEnableWebhookNetworkError extends Data.TaggedError(
  "LegacyConfigPushEnableWebhookNetworkError",
)<NetworkErrorArgs> {}
export class LegacyConfigPushEnableWebhookStatusError extends Data.TaggedError(
  "LegacyConfigPushEnableWebhookStatusError",
)<StatusErrorArgs> {}
