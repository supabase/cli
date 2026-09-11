import { Effect, FileSystem, Path } from "effect";
import type { LocalServiceVersionOverrides } from "../shared/services/services.shared.ts";
import { tempPaths } from "./temp-paths.ts";

/**
 * `supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version` pin
 * files, written by `supabase link` for a linked/bootstrap project and read before any
 * command that pulls or starts these services to override their image tag. `gotrue`/
 * `postgrest` are additionally gated on `majorVersion > 14`.
 */
const VERSION_FILES = [
  ["auth", "gotrue-version", (majorVersion: number | undefined) => (majorVersion ?? 17) > 14],
  ["postgrest", "rest-version", (majorVersion: number | undefined) => (majorVersion ?? 17) > 14],
  ["storage", "storage-version"],
  ["realtime", "realtime-version"],
  ["studio", "studio-version"],
  ["pgmeta", "pgmeta-version"],
  ["analytics", "logflare-version"],
  ["pooler", "pooler-version"],
] as const satisfies ReadonlyArray<
  readonly [
    "auth" | "postgrest" | "storage" | "realtime" | "studio" | "pgmeta" | "analytics" | "pooler",
    string,
    ((majorVersion: number | undefined) => boolean)?,
  ]
>;

/**
 * Reads every linked-service version pin present under `<workdir>/supabase/.temp/`,
 * returning only the services whose pin file exists and is non-blank. Any read error
 * (including not-exist) resolves to "" for that file.
 */
export const readServiceVersionOverrides = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  majorVersion: number | undefined,
) {
  const paths = tempPaths(path, workdir);
  const versions: LocalServiceVersionOverrides = {};

  for (const [service, fileName, shouldRead] of VERSION_FILES) {
    if (shouldRead !== undefined && !shouldRead(majorVersion)) {
      continue;
    }

    const version = yield* fs.readFileString(path.join(paths.tempDir, fileName)).pipe(
      Effect.map((content) => content.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (version.length > 0) {
      versions[service] = version;
    }
  }

  return versions;
});
