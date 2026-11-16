import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandUpdateError extends Data.TaggedError("ExperimentalStackUpdateError")<{
  readonly reason: "flags" | "invalid-config" | "lock" | "hosted";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "hosted":
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.externalNetwork,
            fingerprint_suffix: "network",
          }
        );
      case "lock":
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.invalidConfig,
            fingerprint_suffix: "invalid_config",
          }
        );
    }
  }
}
