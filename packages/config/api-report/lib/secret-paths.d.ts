/**
 * Derived from `CliConfigSchema` once, at module load — the schema's
 * annotations are the single source of truth for which paths are secret; no
 * hand-maintained list exists alongside it. A pattern segment is either a
 * literal key or `"*"` (a dynamic `Schema.Record` key, e.g. `db.vault.*`,
 * `edge_runtime.secrets.*`, `remotes.*.auth.jwt_secret`). Exported (beyond
 * {@link isSecretPath}) so `../project-config/project-config.unit.test.ts`
 * can build an exhaustive secret-strip probe from the same source of truth,
 * rather than a second hand-picked field list.
 */
export declare const secretPathPatterns: (readonly string[])[];
/** Whether `path` (root-relative segments into {@link CliConfigSchema}) names an `x-secret` leaf. */
export declare function isSecretPath(path: ReadonlyArray<string>): boolean;
