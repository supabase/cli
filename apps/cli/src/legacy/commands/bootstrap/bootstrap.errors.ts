import { Data } from "effect";

// ---------------------------------------------------------------------------
// Bootstrap-specific tagged errors. Each maps to a Go `errors.New` / failure
// site in `apps/cli-go/cmd/bootstrap.go` + `internal/bootstrap/bootstrap.go`.
// Login / create / api-keys / link failures are surfaced by the extracted
// shared cores (`legacy/shared/legacy-*`), so they are NOT redefined here.
// ---------------------------------------------------------------------------

/** Positional template arg with no case-insensitive match — Go's `"Invalid template: " + name` (`cmd/bootstrap.go:48`). */
export class LegacyBootstrapInvalidTemplateError extends Data.TaggedError(
  "LegacyBootstrapInvalidTemplateError",
)<{
  readonly message: string;
}> {}

/** GitHub samples listing failure — Go's `failed to list samples` (`bootstrap.go:ListSamples`). */
export class LegacyBootstrapTemplateListError extends Data.TaggedError(
  "LegacyBootstrapTemplateListError",
)<{
  readonly message: string;
}> {}

/** Reading the target workdir failed — Go's `failed to read workdir: %w` (`bootstrap.go:44`). */
export class LegacyBootstrapWorkdirReadError extends Data.TaggedError(
  "LegacyBootstrapWorkdirReadError",
)<{
  readonly message: string;
}> {}

/**
 * User declined the overwrite prompt — Go returns `errors.New(context.Canceled)`
 * (`bootstrap.go:51`). Carries no suggestion frame (cancellation, not a fault).
 */
export class LegacyBootstrapOverwriteDeclinedError extends Data.TaggedError(
  "LegacyBootstrapOverwriteDeclinedError",
)<{
  readonly message: string;
}> {}

/** Template download failure — Go's `failed to download template: %w` (`bootstrap.go:downloadSample`). */
export class LegacyBootstrapTemplateDownloadError extends Data.TaggedError(
  "LegacyBootstrapTemplateDownloadError",
)<{
  readonly message: string;
}> {}

/**
 * Project health probe failed — Go's `Error status %d: %s` (non-200) or
 * `Service not healthy: %s (%s)` (`bootstrap.go:checkProjectHealth`).
 */
export class LegacyBootstrapHealthError extends Data.TaggedError("LegacyBootstrapHealthError")<{
  readonly message: string;
}> {}
