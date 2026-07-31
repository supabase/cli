/**
 * Shared by `gen types` and `gen tanstack-db`: both let the user select
 * schemas via `--schema`/`-s` and fall back to the project's configured
 * `api.schemas` (plus `public`) when no flag value is given.
 */
export function defaultSchemas(extraSchemas: ReadonlyArray<string> = []) {
  return [...new Set(["public", ...extraSchemas])];
}
