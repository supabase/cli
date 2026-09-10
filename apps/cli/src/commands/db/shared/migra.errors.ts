import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * The migra diff failed, either in the edge-runtime run or the OOM bash fallback in the
 * `supabase/migra` Docker image.
 */
export class MigraDiffError extends Data.TaggedError("MigraDiffError")<{
  readonly message: string;
  /**
   * Set from a wrapped `DockerRunError` in the OOM bash fallback so a docker-boundary failure
   * isn't misclassified as user-SQL: `"daemon"` maps to docker-not-running, `"pull"` to an
   * external network problem.
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
 * Loading the target's user-defined schemas for the migra bash fallback failed. Reached only
 * on the OOM fallback path when no `--schema` is given.
 */
export class MigraSchemaLoadError extends Data.TaggedError("MigraSchemaLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
