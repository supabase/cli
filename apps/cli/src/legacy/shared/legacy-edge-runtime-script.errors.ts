import { Data } from "effect";

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
}> {}
