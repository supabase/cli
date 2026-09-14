import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * The edge runtime container stopped with a non-zero, non-`137` exit code
 * while `functions serve` was streaming its logs — a genuine runtime crash,
 * distinct from the graceful (`0`) exit and the retried (`137`) case.
 */
export class EdgeRuntimeContainerCrashedError extends Data.TaggedError(
  "EdgeRuntimeContainerCrashedError",
)<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}

/**
 * The `docker logs -f` process feeding `functions serve` output exited with
 * an error `isRetriableDockerLogsError` does not recognize as transient.
 */
export class DockerLogsStreamError extends Data.TaggedError("DockerLogsStreamError")<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}
