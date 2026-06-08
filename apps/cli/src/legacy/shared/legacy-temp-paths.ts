import type { Path } from "effect";

/**
 * Absolute paths to the files the Go CLI writes under `<workdir>/supabase/.temp/`.
 * Mirrors the `utils.*Path` constants in `apps/cli-go/internal/utils/misc.go:84-98`.
 *
 * `supabase link` / `supabase unlink` are the authoritative writers and remover
 * of this directory, but several layers (`legacy-project-ref.layer.ts`,
 * `legacy-linked-project-cache.layer.ts`) also read from it. Centralising the
 * joins here keeps the path layout in one place instead of re-inlining
 * `path.join(workdir, "supabase", ".temp", "...")` at every call site.
 */
export interface LegacyTempPaths {
  readonly tempDir: string;
  readonly projectRef: string;
  readonly poolerUrl: string;
  readonly postgresVersion: string;
  readonly restVersion: string;
  readonly gotrueVersion: string;
  readonly storageVersion: string;
  readonly storageMigration: string;
  readonly pgmetaVersion: string;
  readonly linkedProjectCache: string;
}

export function legacyTempPaths(path: Path.Path, workdir: string): LegacyTempPaths {
  const tempDir = path.join(workdir, "supabase", ".temp");
  return {
    tempDir,
    projectRef: path.join(tempDir, "project-ref"),
    poolerUrl: path.join(tempDir, "pooler-url"),
    postgresVersion: path.join(tempDir, "postgres-version"),
    restVersion: path.join(tempDir, "rest-version"),
    gotrueVersion: path.join(tempDir, "gotrue-version"),
    storageVersion: path.join(tempDir, "storage-version"),
    storageMigration: path.join(tempDir, "storage-migration"),
    pgmetaVersion: path.join(tempDir, "pgmeta-version"),
    linkedProjectCache: path.join(tempDir, "linked-project.json"),
  };
}
