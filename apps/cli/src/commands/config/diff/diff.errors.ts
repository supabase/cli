import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";
import { mintConfigTargetErrors } from "../../../command-internal/project-target.ts";

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
export class ConfigDiffLoadConfigError extends Data.TaggedError("ConfigDiffLoadConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`validateWorkdirIsDirectory`). Only reachable when the
 * user explicitly set it — beats the config load and every network call.
 */
export class ConfigDiffWorkdirError extends Data.TaggedError("ConfigDiffWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The Go-compat global `-o/--output` flag was passed. `config diff` is a
 * net-new TS command with no Go parity contract, so machine output goes
 * through `--output-format` only (per Colum on CLI-2156).
 */
export class ConfigDiffOutputFlagUnsupportedError extends Data.TaggedError(
  "ConfigDiffOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

const targetErrors = mintConfigTargetErrors("ConfigDiff");

/** `--project-ref` named a branch the parent project does not have. */
export const ConfigDiffBranchNotFoundError = targetErrors.BranchNotFoundError;
export type ConfigDiffBranchNotFoundError = InstanceType<typeof ConfigDiffBranchNotFoundError>;

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under — none of `SUPABASE_PROJECT_ID`,
 * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`
 * yielded a candidate. Mirrors `LinkBranchNotLinkedError`'s
 * classification (link.errors.ts).
 */
export const ConfigDiffBranchNotLinkedError = targetErrors.BranchNotLinkedError;
export type ConfigDiffBranchNotLinkedError = InstanceType<typeof ConfigDiffBranchNotLinkedError>;

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state. Mirrors
 * `LinkParentRefInvalidError`'s classification (link.errors.ts).
 */
export const ConfigDiffParentRefInvalidError = targetErrors.ParentRefInvalidError;
export type ConfigDiffParentRefInvalidError = InstanceType<typeof ConfigDiffParentRefInvalidError>;

/**
 * The resolved branch has no project ref yet (still provisioning) — guards
 * against an empty/placeholder ref reaching `/v2/projects//config`. Mirrors
 * `LinkBranchNotReadyError`'s classification (link.errors.ts).
 */
export const ConfigDiffBranchNotReadyError = targetErrors.BranchNotReadyError;
export type ConfigDiffBranchNotReadyError = InstanceType<typeof ConfigDiffBranchNotReadyError>;

export class ConfigDiffBranchResolveNetworkError extends Data.TaggedError(
  "ConfigDiffBranchResolveNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ConfigDiffBranchResolveStatusError extends Data.TaggedError(
  "ConfigDiffBranchResolveStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class ConfigDiffReadNetworkError extends Data.TaggedError(
  "ConfigDiffReadNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ConfigDiffReadStatusError extends Data.TaggedError(
  "ConfigDiffReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // `/v2/projects/{ref}/config` names a user-selected resource, so a 404
    // means "wrong project ref" — user-actionable, not an external-service
    // problem (same rule as the branch-resolve error above and the
    // ref-addressed push.errors.ts status errors).
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
