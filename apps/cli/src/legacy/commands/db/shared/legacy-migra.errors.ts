import { Data } from "effect";

/**
 * The migra diff failed (edge-runtime run, or the OOM bash fallback in the
 * `supabase/migra` Docker image). Byte-matches Go's
 * `"error diffing schema: %w:\n%s"` wrapping in `DiffSchemaMigra` /
 * `DiffSchemaMigraBash` (`apps/cli-go/internal/db/diff/migra.go`).
 */
export class LegacyMigraDiffError extends Data.TaggedError("LegacyMigraDiffError")<{
  readonly message: string;
}> {}

/**
 * Loading the target's user-defined schemas for the migra bash fallback failed.
 * Byte-matches Go's `migration.ListUserSchemas` → `"failed to list schemas: %w"`
 * (`apps/cli-go/pkg/migration/drop.go:46`); reached only on the OOM fallback path
 * when no `--schema` is given.
 */
export class LegacyMigraSchemaLoadError extends Data.TaggedError("LegacyMigraSchemaLoadError")<{
  readonly message: string;
}> {}
