import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** GitHub samples listing failure — Go's `failed to list samples` (`bootstrap.go:ListSamples`). */
export class LegacyBootstrapTemplateListError extends Data.TaggedError(
  "LegacyBootstrapTemplateListError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** Reading the target workdir failed — Go's `failed to read workdir: %w` (`bootstrap.go:44`). */
export class LegacyBootstrapWorkdirReadError extends Data.TaggedError(
  "LegacyBootstrapWorkdirReadError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * User declined the overwrite prompt — Go returns `errors.New(context.Canceled)`
 * (`bootstrap.go:51`). Carries no suggestion frame (cancellation, not a fault).
 */
export class LegacyBootstrapOverwriteDeclinedError extends Data.TaggedError(
  "LegacyBootstrapOverwriteDeclinedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/** Template download failure — Go's `failed to download template: %w` (`bootstrap.go:downloadSample`). */
export class LegacyBootstrapTemplateDownloadError extends Data.TaggedError(
  "LegacyBootstrapTemplateDownloadError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * Project health probe failed — Go's `Error status %d: %s` (non-200) or
 * `Service not healthy: %s (%s)` (`bootstrap.go:checkProjectHealth`).
 */
export class LegacyBootstrapHealthError extends Data.TaggedError("LegacyBootstrapHealthError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}
