import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

// ---------------------------------------------------------------------------
// Bootstrap-specific tagged errors. Each maps to a Go `errors.New` / failure
// site in `apps/cli-go/cmd/bootstrap.go` + `internal/bootstrap/bootstrap.go`
// (deleted in CLI-1970; last present at commit 7b469f5b3).
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
  /** Set when the health poll itself failed with a non-200; absent when the
   * service reported unhealthy. */
  readonly status?: number;
  /** Set when the health poll's response came back with a 200 the generated
   * client could not decode (`SchemaError`) — an API-response
   * problem, not a transport failure. */
  readonly decode?: boolean;
  /** Set when the health poll failed without any HTTP response (DNS, TLS,
   * timeout) — a network failure, not an API status. */
  readonly transport?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.status !== undefined) return statusCodeActionability(this.status);
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    if (this.transport === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    return actionability.apiStatus;
  }
}
