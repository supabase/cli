import { Data } from "effect";

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
}> {}

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
}> {}

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
}> {}

/**
 * Parsing the declarative export envelope failed. Byte-matches Go's
 * `"failed to parse declarative export output: " + err`
 * (`apps/cli-go/internal/db/diff/pgdelta.go:192`).
 */
export class LegacyDeclarativeParseOutputError extends Data.TaggedError(
  "LegacyDeclarativeParseOutputError",
)<{
  readonly message: string;
}> {}

/**
 * Listing local migrations failed for a reason other than the directory being
 * absent. Byte-matches Go's `migration.ListLocalMigrations`
 * (`apps/cli-go/pkg/migration/list.go:34-37`), which returns
 * `"failed to read directory: " + err` for anything but `os.ErrNotExist` rather
 * than treating an unreadable `supabase/migrations` as "no migrations".
 */
export class LegacyMigrationsReadError extends Data.TaggedError("LegacyMigrationsReadError")<{
  readonly message: string;
}> {}

/**
 * Materializing the declarative export on disk failed. Byte-matches Go's
 * `WriteDeclarativeSchemas` errors (`declarative.go:239`):
 * `"failed to clean declarative schema directory: " + err` and
 * `"unsafe declarative export path: " + path`. Shared by `db schema declarative
 * generate`/`sync` and `db pull --declarative`.
 */
export class LegacyDeclarativeWriteError extends Data.TaggedError("LegacyDeclarativeWriteError")<{
  readonly message: string;
}> {}
