import { Data } from "effect";

export class LegacyFunctionsNewInvalidSlugError extends Data.TaggedError(
  "LegacyFunctionsNewInvalidSlugError",
)<{
  readonly message: string;
  readonly detail: string;
}> {}

export class LegacyFunctionsNewFileExistsError extends Data.TaggedError(
  "LegacyFunctionsNewFileExistsError",
)<{
  readonly path: string;
  readonly message: string;
  readonly suggestion: string;
}> {}

export class LegacyFunctionsNewWriteError extends Data.TaggedError("LegacyFunctionsNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {}

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
