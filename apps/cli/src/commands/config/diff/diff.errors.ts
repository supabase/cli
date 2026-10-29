import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

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

/** The `-o/--output` flag was passed; this command only supports `--output-format`. */
export class ConfigDiffOutputFlagUnsupportedError extends Data.TaggedError(
  "ConfigDiffOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
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
    // `/v2/projects/{ref}/config` names a user-selected resource, so a 404 means "wrong
    // project ref" — user-actionable, not an external-service problem.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
