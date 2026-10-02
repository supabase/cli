import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export class FunctionsNewInvalidSlugError extends Data.TaggedError("FunctionsNewInvalidSlugError")<{
  readonly message: string;
  readonly detail: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionsNewFileExistsError extends Data.TaggedError("FunctionsNewFileExistsError")<{
  readonly path: string;
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionsNewWriteError extends Data.TaggedError("FunctionsNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory. Checked before slug validation and any filesystem write, so a
 * typo'd `--workdir` can never scaffold a fresh tree at the wrong path.
 */
export class FunctionsNewWorkdirError extends Data.TaggedError("FunctionsNewWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Maps a thrown filesystem-write cause to a typed `FunctionsNewWriteError`
 * tagged with `path`. Shared by the `.vscode` and `.idea/deno.xml` writers.
 */
export function mapFunctionsNewWriteError(path: string) {
  return (cause: unknown): FunctionsNewWriteError =>
    new FunctionsNewWriteError({
      path,
      message:
        typeof cause === "object" && cause !== null && "message" in cause
          ? String(cause.message)
          : String(cause),
    });
}
