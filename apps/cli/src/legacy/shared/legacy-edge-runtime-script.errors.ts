import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Running a TypeScript program inside the edge-runtime container failed (non-zero
 * exit whose stderr does not contain `"main worker has been destroyed"`, which
 * Go intentionally swallows). Byte-matches Go's wrapping
 * `errors.Errorf("%s: %w:\n%s", errPrefix, err, stderr)` in `RunEdgeRuntimeScript`
 * (`apps/cli-go/internal/utils/edgeruntime.go`), where `errPrefix` is supplied by
 * the caller (e.g. `"error diffing schema"`).
 */
export class LegacyEdgeRuntimeScriptError extends Data.TaggedError("LegacyEdgeRuntimeScriptError")<{
  readonly message: string;
  /**
   * Threaded from a wrapped `LegacyDockerRunError` so a docker-boundary failure
   * (docker daemon down or registry pull) does not misclassify as a user-SQL
   * (`dbFinding`) failure. `daemon` maps to docker-not-running, `pull` to an
   * external network problem. `undefined` for genuine script/config failures,
   * which keep the user-SQL classification.
   */
  readonly docker?: "daemon" | "inspect" | "pull";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.docker === "daemon") {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    if (this.docker === "pull") {
      return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
    }
    if (this.docker === "inspect") {
      return { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
    }
    return actionability.dbFinding;
  }
}
