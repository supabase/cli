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

interface MessageOnlyArgs {
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
)<MessageOnlyArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

// --- branch/UUID resolution (CLI-2289) --------------------------------------
//
// `--project-ref` accepts a project ref, or the name (or UUID) of one of its
// branches — mirrors `config diff`'s own error set 1:1, under push's own
// names (`diff.errors.ts`).

/** `--project-ref` named a branch the parent project does not have. */
export class LegacyConfigPushBranchNotFoundError extends Data.TaggedError(
  "LegacyConfigPushBranchNotFoundError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under — none of `SUPABASE_PROJECT_ID`,
 * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`
 * yielded a candidate.
 */
export class LegacyConfigPushBranchNotLinkedError extends Data.TaggedError(
  "LegacyConfigPushBranchNotLinkedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state.
 */
export class LegacyConfigPushParentRefInvalidError extends Data.TaggedError(
  "LegacyConfigPushParentRefInvalidError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/**
 * The resolved branch has no project ref yet (still provisioning) — guards
 * against an empty/placeholder ref reaching a push target.
 */
export class LegacyConfigPushBranchNotReadyError extends Data.TaggedError(
  "LegacyConfigPushBranchNotReadyError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
  }
}

export class LegacyConfigPushBranchResolveNetworkError extends Data.TaggedError(
  "LegacyConfigPushBranchResolveNetworkError",
)<DecodableNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyConfigPushBranchResolveStatusError extends Data.TaggedError(
  "LegacyConfigPushBranchResolveStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// --- live branch detection (CLI-2168) ---------------------------------------
//
// The `getProject` probe that tells the user whether `ref` is the linked
// project or one of its branches is entirely best-effort: a 404 is the
// branch signal (handled by `legacyClassifyProjectLookupError`), and any
// OTHER outcome — a timeout, a transport failure, or a non-200/404 status
// (e.g. a scoped token that can write service config but can't read the
// project record) — degrades to an uncertain target rather than aborting the
// push. There is deliberately no error class for this probe: it never fails
// the command.

// --- branch confirmation gate (CLI-2168) ------------------------------------

/** The user declined the branch confirmation gate. Mirrors `projects
 * delete`/`db reset`'s identical top-level "are you sure" cancellation
 * shape — declining now FAILS (exit 1), matching every other top-level
 * confirmation gate in this codebase; the per-service `keep()` prompts below
 * are unrelated and still exit 0 on decline. `suggestion` always names the
 * `--yes`/`SUPABASE_YES` escape hatch — the interactive prompt label already
 * carries an inline hint, but a machine-mode or non-TTY decline never renders
 * that label at all (`legacyPromptYesNo` returns the default silently), so
 * this is the only place those callers see it. */
export class LegacyConfigPushCancelledError extends Data.TaggedError(
  "LegacyConfigPushCancelledError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
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

/**
 * The effective project config read returned 200 with NO block populated at
 * all (`scope.present` empty) — a scoped or otherwise restricted token most
 * plausibly produces this. Pushing against an empty remote view would mean
 * treating every locally declared property as a fresh write with no remote
 * value to compare against, so this aborts before touching any resource
 * rather than risk that.
 */
export class LegacyConfigPushConfigEmptyError extends Data.TaggedError(
  "LegacyConfigPushConfigEmptyError",
)<MessageOnlyArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.accountAccess;
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
