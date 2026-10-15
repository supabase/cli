import type { Path } from "effect";

/** Directory under `<workdir>/supabase` that holds legacy link and cache state. */
export const LEGACY_PROJECT_STATE_DIRNAME = ".temp";

/** A single-value file in the legacy project state directory. */
export type LegacyStateFile =
  | "projectRef"
  | "poolerUrl"
  | "postgresVersion"
  | "edgeRuntimeVersion"
  | "gotrueVersion"
  | "restVersion"
  | "storageVersion"
  | "realtimeVersion"
  | "studioVersion"
  | "pgmetaVersion"
  | "logflareVersion"
  | "poolerVersion"
  | "storageMigration"
  | "linkedProjectCache"
  | "cliLatest";

/** Absolute locations of everything the CLI keeps under `<workdir>/supabase/.temp`. */
export interface LegacyProjectStatePaths extends Readonly<Record<LegacyStateFile, string>> {
  readonly tempDir: string;
  readonly pgdeltaDir: string;
  readonly stackUploadsDir: string;
  readonly startSecretsDir: string;
}

/** The only definition of the legacy `supabase/.temp` layout. Pure, so it runs before any layer. */
export function legacyProjectStatePaths(
  path: Pick<Path.Path, "join">,
  workdir: string,
): LegacyProjectStatePaths {
  const tempDir = path.join(workdir, "supabase", LEGACY_PROJECT_STATE_DIRNAME);
  const inTemp = (name: string) => path.join(tempDir, name);
  return {
    tempDir,
    projectRef: inTemp("project-ref"),
    poolerUrl: inTemp("pooler-url"),
    postgresVersion: inTemp("postgres-version"),
    edgeRuntimeVersion: inTemp("edge-runtime-version"),
    gotrueVersion: inTemp("gotrue-version"),
    restVersion: inTemp("rest-version"),
    storageVersion: inTemp("storage-version"),
    realtimeVersion: inTemp("realtime-version"),
    studioVersion: inTemp("studio-version"),
    pgmetaVersion: inTemp("pgmeta-version"),
    logflareVersion: inTemp("logflare-version"),
    poolerVersion: inTemp("pooler-version"),
    storageMigration: inTemp("storage-migration"),
    linkedProjectCache: inTemp("linked-project.json"),
    cliLatest: inTemp("cli-latest"),
    pgdeltaDir: inTemp("pgdelta"),
    stackUploadsDir: inTemp("stack-uploads"),
    startSecretsDir: inTemp("start-secrets"),
  };
}
