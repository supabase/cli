import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

interface NetworkErrorArgs {
  readonly message: string;
  readonly decode?: boolean;
}

interface StatusErrorArgs {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}

/** Local config file missing or unparseable. Aborts before any network call. */
export class LegacyConfigDiffLoadConfigError extends Data.TaggedError(
  "LegacyConfigDiffLoadConfigError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** `--project-ref` named a branch the parent project does not have. */
export class LegacyConfigDiffBranchNotFoundError extends Data.TaggedError(
  "LegacyConfigDiffBranchNotFoundError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under — none of `SUPABASE_PROJECT_ID`,
 * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`
 * yielded a candidate. Mirrors `LegacyLinkBranchNotLinkedError`'s
 * classification (link.errors.ts).
 */
export class LegacyConfigDiffBranchNotLinkedError extends Data.TaggedError(
  "LegacyConfigDiffBranchNotLinkedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state. Mirrors
 * `LegacyLinkParentRefInvalidError`'s classification (link.errors.ts).
 */
export class LegacyConfigDiffParentRefInvalidError extends Data.TaggedError(
  "LegacyConfigDiffParentRefInvalidError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/**
 * The resolved branch has no project ref yet (still provisioning) — guards
 * against an empty/placeholder ref reaching `/v2/projects//config`. Mirrors
 * `LegacyLinkBranchNotReadyError`'s classification (link.errors.ts).
 */
export class LegacyConfigDiffBranchNotReadyError extends Data.TaggedError(
  "LegacyConfigDiffBranchNotReadyError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
  }
}

export class LegacyConfigDiffBranchResolveNetworkError extends Data.TaggedError(
  "LegacyConfigDiffBranchResolveNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyConfigDiffBranchResolveStatusError extends Data.TaggedError(
  "LegacyConfigDiffBranchResolveStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyConfigDiffReadNetworkError extends Data.TaggedError(
  "LegacyConfigDiffReadNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyConfigDiffReadStatusError extends Data.TaggedError(
  "LegacyConfigDiffReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // `/v2/projects/{ref}/config` names a user-selected resource, so a 404
    // means "wrong project ref" — user-actionable, not an external-service
    // problem (same rule as the branch-resolve error above and the
    // ref-addressed push.errors.ts status errors).
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
