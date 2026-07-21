import { Effect, FileSystem, Path } from "effect";
import type { LocalServiceVersionOverrides } from "../../shared/services/services.shared.ts";
import { legacyTempPaths } from "./legacy-temp-paths.ts";

/**
 * `supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version`
 * pin files — written by `supabase link` for a linked/bootstrap project, read
 * by Go's `Config.Load` to rewrite `c.Auth.Image`/`c.Api.Image`/etc. before any
 * command that pulls or starts these services (`apps/cli-go/pkg/config/
 * config.go:827-863`). `gotrue`/`postgrest` are additionally gated on
 * `majorVersion > 14`, mirroring Go's same condition there.
 */
const LEGACY_VERSION_FILES = [
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
 * Reads every linked-service version pin present under `<workdir>/supabase/
 * .temp/`, returning only the services whose pin file exists and is
 * non-blank. Any read error (including not-exist) resolves to "" for that
 * file, matching Go's `err == nil && len(version) > 0` gate.
 */
export const legacyReadServiceVersionOverrides = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  majorVersion: number | undefined,
) {
  const paths = legacyTempPaths(path, workdir);
  const versions: LocalServiceVersionOverrides = {};

  for (const [service, fileName, shouldRead] of LEGACY_VERSION_FILES) {
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
