import { Data } from "effect";
import type { ConfigFormat } from "./io.ts";

export class ProjectConfigParseError extends Data.TaggedError("ProjectConfigParseError")<{
  readonly path: string;
  readonly format: ConfigFormat;
  readonly cause: unknown;
}> {}

export class ProjectEnvParseError extends Data.TaggedError("ProjectEnvParseError")<{
  readonly path: string;
  readonly line: number;
}> {}

export class MissingProjectConfigValueError extends Data.TaggedError(
  "MissingProjectConfigValueError",
)<{
  readonly configPath: string;
}> {}

/**
 * Two `[remotes.*]` blocks declare the same `project_id` as the requested
 * `projectRef`. Mirrors Go's `loadFromFile` guard
 * (`apps/cli-go/pkg/config/config.go:508-509`); `message` matches the Go string
 * verbatim so callers can surface it without rewrapping.
 */
export class DuplicateRemoteProjectIdError extends Data.TaggedError(
  "DuplicateRemoteProjectIdError",
)<{
  readonly message: string;
}> {}

/**
 * A `[remotes.<name>]` block's `project_id` is not a valid 20-lowercase-letter
 * project ref. Mirrors Go's `Config.Validate` (`apps/cli-go/pkg/config/config.go:
 * 558,996-1001`), which checks every remote's `project_id` against `refPattern`
 * on every config load — regardless of whether that remote ends up selected —
 * so this fails before Docker/API access, same as Go. `message` matches the Go
 * string verbatim so callers can surface it without rewrapping.
 */
export class InvalidRemoteProjectIdError extends Data.TaggedError("InvalidRemoteProjectIdError")<{
  readonly message: string;
}> {}
