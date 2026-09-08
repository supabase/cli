import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Setting up / connecting to / migrating the throwaway shadow database failed.
 * Wraps the errors from `CreateShadowDatabase` / `ConnectShadowDatabase` /
 * `SetupShadowDatabase` / `MigrateShadowDatabase`
 * (`apps/cli-go/internal/db/diff/diff.go`).
 */
export class DeclarativeShadowDbError extends Data.TaggedError("DeclarativeShadowDbError")<{
  readonly message: string;
  readonly docker?: "daemon";
  /** Recovery hint carried over from the underlying failure (e.g. a health-check
   *  timeout's exact image-removal command), so the seam surfaces the same
   *  actionable suggestion `db start` itself would render. */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.docker === "daemon"
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : actionability.startStack;
  }
}

/**
 * Materializing the declarative export on disk failed. Byte-matches Go's
 * `WriteDeclarativeSchemas` errors (`declarative.go:239`):
 * `"failed to clean declarative schema directory: " + err` and
 * `"unsafe declarative export path: " + path`. Shared by `db schema declarative
 * generate`/`sync` and `db pull --declarative`.
 */
export class DeclarativeWriteError extends Data.TaggedError("DeclarativeWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
