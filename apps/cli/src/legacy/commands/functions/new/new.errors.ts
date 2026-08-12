import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyFunctionsNewInvalidSlugError extends Data.TaggedError(
  "LegacyFunctionsNewInvalidSlugError",
)<{
  readonly message: string;
  readonly detail: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyFunctionsNewFileExistsError extends Data.TaggedError(
  "LegacyFunctionsNewFileExistsError",
)<{
  readonly path: string;
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyFunctionsNewWriteError extends Data.TaggedError("LegacyFunctionsNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Maps an arbitrary thrown cause from a filesystem write to a typed
 * `LegacyFunctionsNewWriteError` tagged with the given `path`. Used by the IDE
 * settings writers, where the same shape is needed for both the `.vscode` and
 * `.idea/deno.xml` targets.
 */
export function mapLegacyFunctionsNewWriteError(path: string) {
  return (cause: unknown): LegacyFunctionsNewWriteError =>
    new LegacyFunctionsNewWriteError({
      path,
      message:
        typeof cause === "object" && cause !== null && "message" in cause
          ? String(cause.message)
          : String(cause),
    });
}
