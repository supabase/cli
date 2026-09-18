import { Data } from "effect";
import type { ConfigFormat } from "./config-format.ts";

export class CliConfigParseError extends Data.TaggedError("CliConfigParseError")<{
  readonly path: string;
  readonly format: ConfigFormat;
  readonly cause: unknown;
  /**
   * The pre-decode `edge_runtime` subtree, present only when a schema decode failure discarded
   * the rest of the document (schema decode is all-or-nothing). `edge_runtime.secrets` values
   * stay wrapped in `Redacted` so this can't leak a resolved secret if left uncaught.
   */
  readonly document?: { readonly edge_runtime?: unknown };
  /**
   * Name of the matched `[remotes.<name>]` block; present even when the decode itself fails,
   * since remote selection happens first. Mirrors {@link LoadedCliConfig}'s `appliedRemote`.
   */
  readonly appliedRemote?: string;
}> {}

const PROJECT_CONFIG_PARSE_ERROR_MESSAGE_PREFIX =
  "Could not read the project config from the Management API response";

/** Formats a {@link ProjectConfigParseError} message, appending the API-attributes path when given. */
export function formatProjectConfigParseErrorMessage(
  detail: string,
  apiPath?: ReadonlyArray<string>,
): string {
  if (apiPath === undefined || apiPath.length === 0) {
    return `${PROJECT_CONFIG_PARSE_ERROR_MESSAGE_PREFIX}: ${detail}`;
  }
  return `${PROJECT_CONFIG_PARSE_ERROR_MESSAGE_PREFIX}: at ${["data", "attributes", ...apiPath].join(".")}: ${detail}`;
}

/** Suggested remediation attached to every {@link ProjectConfigParseError}. */
export const PROJECT_CONFIG_PARSE_ERROR_SUGGESTION =
  "Try upgrading the Supabase CLI to the latest version. If the error persists on the latest version, report it at https://github.com/supabase/cli/issues.";

/**
 * A Management API v2 project-config response failed to map into a {@link ProjectConfig}.
 * Unmapped keys never trigger this on their own; a payload with an own `data` or `attributes`
 * key is treated as an envelope even when it was meant as bare attributes.
 */
export class ProjectConfigParseError extends Data.TaggedError("ProjectConfigParseError")<{
  readonly message: string;
  /**
   * `"api_response"` (default) — the platform payload itself failed to decode or map.
   * `"caller_misuse"` — the caller passed this package's own API an invalid argument; the
   * upgrade suggestion does not apply and this should not be reported as a platform failure.
   */
  readonly reason?: "api_response" | "caller_misuse";
  /**
   * Path under v2 `data.attributes` of the offending value; `undefined` when
   * the response envelope/attributes shape itself failed to decode.
   */
  readonly apiPath?: ReadonlyArray<string>;
  readonly cause: unknown;
  /** Fuller, multi-issue detail beyond `message`'s single-issue summary. */
  readonly detail?: string;
  readonly suggestion?: string;
}> {}

export class CliProjectEnvParseError extends Data.TaggedError("CliProjectEnvParseError")<{
  readonly path: string;
  readonly line: number;
}> {}

/** Two `[remotes.*]` blocks declare the same `project_id` as the requested `projectRef`. */
export class DuplicateRemoteProjectIdError extends Data.TaggedError(
  "DuplicateRemoteProjectIdError",
)<{
  readonly message: string;
}> {}

/** A `[remotes.<name>]` block's `project_id` is not a valid 20-lowercase-letter project ref. */
export class InvalidRemoteProjectIdError extends Data.TaggedError("InvalidRemoteProjectIdError")<{
  readonly message: string;
}> {}

/**
 * Replacing a config document's on-disk text failed: the temp-file write, mode copy, or final
 * rename onto {@link path}. `cause` carries the underlying `PlatformError`.
 */
export class CliConfigWriteError extends Data.TaggedError("CliConfigWriteError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}
