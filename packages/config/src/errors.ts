import { Data } from "effect";
import type { ConfigFormat } from "./io.ts";

export class ProjectConfigParseError extends Data.TaggedError("ProjectConfigParseError")<{
  readonly path: string;
  readonly format: ConfigFormat;
  readonly cause: unknown;
  /**
   * The pre-schema-decode `edge_runtime` subtree (post env-interpolation and
   * `[remotes.*]` merge) — present only when the failure happened during
   * *schema* decode (`Schema.decodeUnknownSync`), not during raw TOML/JSON
   * parsing. `Schema.decodeUnknownSync` is all-or-nothing: a single invalid
   * field anywhere in the document discards the entire decode, unlike Go's
   * `viper`+`mapstructure` decode (`apps/cli-go/pkg/config/config.go:749`),
   * which mutates the target struct field-by-field and keeps whatever
   * independently decoded before hitting an unrelated error. Callers that
   * need Go's tolerance for a single subtree (e.g. `secrets set` recovering
   * `edge_runtime.secrets` when an unrelated field like `analytics.port` is
   * malformed) can re-decode this subtree against the full schema themselves.
   * Only `edge_runtime` is retained, not the whole document — several callers
   * of `loadProjectConfig` don't catch `ProjectConfigParseError` at all, so
   * this error can propagate with whatever is attached here, and no caller
   * needs anything outside `edge_runtime` today. Every `edge_runtime.secrets`
   * value is wrapped in `Redacted` (mirroring `secret()`'s `x-secret`
   * treatment elsewhere in this package) so an uncaught error can't
   * accidentally leak a resolved secret into a log or trace; callers must
   * unwrap via `Redacted.value` before re-decoding. `undefined` when the
   * document never parsed at all — that class has no recoverable structure in
   * either implementation.
   */
  readonly document?: { readonly edge_runtime?: unknown };
  /**
   * Name of the `[remotes.<name>]` block whose subtree was merged over the
   * base document before the decode that produced this error, when a
   * `projectRef` was supplied and one matched. Mirrors `appliedRemote` on
   * {@link LoadedProjectConfig} for the success path. Go's `loadFromFile`
   * prints `Loading config override: [remotes.<name>]` to stderr
   * unconditionally, *before* `mapstructure` decode ever runs
   * (`apps/cli-go/pkg/config/config.go:604-609`) — so the notice is still due
   * even when the subsequent decode fails. Callers that tolerate a
   * schema-decode failure and keep going (e.g. `secrets set`) must surface
   * this themselves; callers that let the error propagate get no such
   * notice from Go either, since `c.load(v)` fails before `Run` prints
   * anything else. `undefined` when no `projectRef` was requested or none
   * matched — same as the raw-parse-failure case, where remote merging never
   * runs at all.
   */
  readonly appliedRemote?: string;
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
