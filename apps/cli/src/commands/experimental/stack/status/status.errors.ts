import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackStatusError extends Data.TaggedError(
  "LegacyExperimentalStackStatusError",
)<{
  readonly message: string;
  readonly reason: "flags" | "not-found" | "invalid-config" | "runtime";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "flags" || this.reason === "not-found") return actionability.provideFlags;
    return this.reason === "runtime" ? actionability.externalNetwork : actionability.invalidConfig;
  }
}
