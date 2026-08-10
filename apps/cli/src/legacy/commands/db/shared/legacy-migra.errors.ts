import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The migra diff failed (edge-runtime run, or the OOM bash fallback in the
 * `supabase/migra` Docker image). Byte-matches Go's
 * `"error diffing schema: %w:\n%s"` wrapping in `DiffSchemaMigra` /
 * `DiffSchemaMigraBash` (`apps/cli-go/internal/db/diff/migra.go`).
 */
export class LegacyMigraDiffError extends Data.TaggedError("LegacyMigraDiffError")<{
  readonly message: string;
  /**
   * Threaded from a wrapped `LegacyDockerRunError` in the OOM bash fallback so a
   * docker-boundary failure (docker daemon down or registry pull) does not
   * misclassify as a user-SQL (`dbFinding`) failure. `daemon` maps to
   * docker-not-running, `pull` to an external network problem. `undefined` for
   * genuine diff/script failures, which keep the user-SQL classification.
   */
  readonly docker?: "daemon" | "pull";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.docker === "daemon") {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    if (this.docker === "pull") {
      return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
    }
    return actionability.dbFinding;
  }
}

/**
 * Loading the target's user-defined schemas for the migra bash fallback failed.
 * Byte-matches Go's `migration.ListUserSchemas` → `"failed to list schemas: %w"`
 * (`apps/cli-go/pkg/migration/drop.go:46`); reached only on the OOM fallback path
 * when no `--schema` is given.
 */
export class LegacyMigraSchemaLoadError extends Data.TaggedError("LegacyMigraSchemaLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
