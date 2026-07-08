import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The pg-delta edge-runtime script failed. Byte-matches Go's
 * `"<errPrefix>: <err>:\n<stderr>"` wrapping in `RunEdgeRuntimeScript`
 * (`apps/cli-go/internal/utils/edgeruntime.go`), where `errPrefix` is e.g.
 * `"error diffing schema"` / `"error exporting declarative schema"` /
 * `"error exporting pg-delta catalog"`.
 */
export class LegacyDeclarativeEdgeRuntimeError extends Data.TaggedError(
  "LegacyDeclarativeEdgeRuntimeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * Setting up / connecting to / migrating the throwaway shadow database failed.
 * Wraps the errors from `CreateShadowDatabase` / `ConnectShadowDatabase` /
 * `SetupShadowDatabase` / `MigrateShadowDatabase`
 * (`apps/cli-go/internal/db/diff/diff.go`).
 */
export class LegacyDeclarativeShadowDbError extends Data.TaggedError(
  "LegacyDeclarativeShadowDbError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * Exporting declarative schema produced no output. Byte-matches Go's
 * `"error exporting declarative schema: edge-runtime script produced no output:\n<stderr>"`
 * and the catalog variant `"error exporting pg-delta catalog: edge-runtime script
 * produced no output:\n<stderr>"` (`apps/cli-go/internal/db/diff/pgdelta.go:188,222`).
 */
export class LegacyDeclarativeEmptyOutputError extends Data.TaggedError(
  "LegacyDeclarativeEmptyOutputError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

/**
 * Parsing the declarative export envelope failed. Byte-matches Go's
 * `"failed to parse declarative export output: " + err`
 * (`apps/cli-go/internal/db/diff/pgdelta.go:192`).
 */
export class LegacyDeclarativeParseOutputError extends Data.TaggedError(
  "LegacyDeclarativeParseOutputError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

/**
 * Materializing the declarative export on disk failed. Byte-matches Go's
 * `WriteDeclarativeSchemas` errors (`declarative.go:239`):
 * `"failed to clean declarative schema directory: " + err` and
 * `"unsafe declarative export path: " + path`. Shared by `db schema declarative
 * generate`/`sync` and `db pull --declarative`.
 */
export class LegacyDeclarativeWriteError extends Data.TaggedError("LegacyDeclarativeWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
