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
