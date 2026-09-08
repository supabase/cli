import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class GenTypesNetworkError extends Data.TaggedError("GenTypesNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class GenTypesUnexpectedStatusError extends Data.TaggedError(
  "GenTypesUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class InvalidGenTypesDurationError extends Data.TaggedError("InvalidGenTypesDurationError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class InvalidGenTypesDatabaseUrlError extends Data.TaggedError(
  "InvalidGenTypesDatabaseUrlError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`validateWorkdirIsDirectory`). Only reachable when the
 * user explicitly set it — beats every one of this command's own guards.
 */
export class GenTypesWorkdirError extends Data.TaggedError("GenTypesWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `loadCliConfig` failed to parse `supabase/config.toml`/`config.json`, or
 * found two `[remotes.*]` blocks declaring the same `project_id`. Mirrors
 * `ConfigDiffLoadConfigError`'s parse-error/duplicate-remote handling
 * (`config diff`'s `loadLocalConfig`) so a malformed config reports its own
 * parse failure instead of the raw `CliConfigParseError`/
 * `DuplicateRemoteProjectIdError` tag leaking through as the message.
 */
export class GenTypesParseConfigError extends Data.TaggedError("GenTypesParseConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` holds no project config, on a
 * path that would otherwise load one (`--linked`/`--project-id`/`--db-url`,
 * or the linked fallback) — raised instead of silently falling back to the
 * embedded default schemas, which would drop a declared `[api].schemas` and
 * write a public-only types file at exit 0. A DEFAULTED workdir keeps the
 * established tolerant fallback.
 */
export class GenTypesMissingProjectConfigError extends Data.TaggedError(
  "GenTypesMissingProjectConfigError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
