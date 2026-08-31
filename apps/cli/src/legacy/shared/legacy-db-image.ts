import { Effect, type FileSystem, type Path } from "effect";
import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { slimImageForCurrentPin } from "../../shared/services/slim-images.ts";

/**
 * Resolves the local Postgres Docker image the way `config.Load` does,
 * for commands that run a
 * pg_dump / shadow-DB container (`db dump`, declarative). Promote/extend this if
 * the full service-image resolution is ever needed.
 *
 * The default PG image is read from the same embedded Dockerfile manifest Go parses
 * into `config.Images`, so the TS port tracks Dependabot bumps in that source.
 */

// Read per call, not captured at import time, so `SUPABASE_USE_SLIM_IMAGES` is
// observed by the resolver (and by tests that stub the env).
const legacyPgImageRaw = () => dockerfileServiceImageRaw("pg");
// Major-version fallbacks and the OrioleDB tags below have no slim build.
const LEGACY_PG14 = "supabase/postgres:14.1.0.89";
const LEGACY_PG15 = "supabase/postgres:15.8.1.085";

/** Replace everything after the first `:` with `tag`. */
function replaceImageTag(image: string, tag: string): string {
  const index = image.indexOf(":");
  return image.slice(0, index + 1) + tag.trim();
}

/**
 * `VersionCompare`: compares semver, treating a
 * 4th+ dotted component as a build suffix. Returns <0, 0, or >0.
 */
function versionCompare(a: string, b: string): number {
  const split = (v: string): [string, string] => {
    const parts = v.split(".");
    if (parts.length > 3) {
      return [parts.slice(0, 3).join("."), parts.slice(3).join(".").replace(/^0+/, "")];
    }
    return [v, ""];
  };
  const [aMain, aPre] = split(a);
  const [bMain, bPre] = split(b);
  const cmp = compareSemver(aMain, bMain);
  if (cmp !== 0) return cmp;
  return compareSemver(aPre, bPre);
}

function compareSemver(a: string, b: string): number {
  const an = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bn = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(an.length, bn.length);
  for (let i = 0; i < len; i++) {
    const av = an[i] ?? 0;
    const bv = bn[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export interface LegacyResolvedDbImage {
  /** Pull/create reference — slim-translated when the flag is on and the pin is current. */
  readonly image: string;
  /**
   * Unprefixed docker.io / OrioleDB / 13–15 identity for version-compare.
   * Never `ghcr.io/...` — {@link legacyPostgresImageVersionTag} splits on the first `:`.
   */
  readonly configImage: string;
}

/**
 * Resolve the Postgres image for `majorVersion`, honoring the pinned version
 * written by `supabase start` to `supabase/.temp/postgres-version` (Go reads
 * `builder.PostgresVersionPath` and only replaces the tag when the configured
 * image is at/above 15.1.0.55).
 */
export const legacyResolveDbImage = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  majorVersion: number,
  orioledbVersion?: string,
) {
  // OrioleDB override (`config.Validate`): on a
  // 15/17 project with `experimental.orioledb_version` set, the Postgres image is
  // replaced with the OrioleDB tag, taking precedence over the default/pinned image.
  if (
    orioledbVersion !== undefined &&
    orioledbVersion.length > 0 &&
    (majorVersion === 15 || majorVersion === 17)
  ) {
    const image =
      versionCompare(orioledbVersion, "15.1.1.13") > 0
        ? `supabase/postgres:${orioledbVersion}-orioledb`
        : `supabase/postgres:orioledb-${orioledbVersion}`;
    return { image, configImage: image };
  }
  const usedFallback = majorVersion === 13 || majorVersion === 14 || majorVersion === 15;
  let image = usedFallback ? (majorVersion === 14 ? LEGACY_PG14 : LEGACY_PG15) : legacyPgImageRaw();
  let appliedPin: string | undefined;
  if (majorVersion > 14) {
    const versionPath = path.join(workdir, "supabase", ".temp", "postgres-version");
    const pinned = yield* fs.readFileString(versionPath).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (pinned.length > 0) {
      const colon = image.indexOf(":");
      const currentTag = colon >= 0 ? image.slice(colon + 1) : image;
      if (versionCompare(currentTag, "15.1.0.55") >= 0) {
        image = replaceImageTag(image, pinned);
        appliedPin = pinned;
      }
    }
  }
  // 13/14/15 fallbacks have no slim build. Historical PG17 pins stay docker.io.
  if (usedFallback) {
    return { image, configImage: image };
  }
  const configImage =
    appliedPin !== undefined ? replaceImageTag(legacyPgImageRaw(), appliedPin) : legacyPgImageRaw();
  return {
    image: slimImageForCurrentPin("pg", legacyPgImageRaw(), appliedPin),
    configImage,
  };
});
