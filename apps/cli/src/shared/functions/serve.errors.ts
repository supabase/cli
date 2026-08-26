import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * A newline-containing function secret while `SUPABASE_USE_SLIM_IMAGES` is on.
 * Multiline values reach the container through a sourced shell script, and the
 * slim edge-runtime image is distroless — it ships no shell to source it.
 */
export class SlimEdgeRuntimeMultilineSecretError extends Data.TaggedError(
  "SlimEdgeRuntimeMultilineSecretError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The remediation is editing the env file or the flag, not re-running with
    // different arguments, so `invalidConfig` (which declares its
    // update-config suggestion) fits better than `invalidInput`.
    return actionability.invalidConfig;
  }
}
