import { Effect, type FileSystem, type Path } from "effect";

/**
 * Resolves the local Postgres Docker image the way Go's `config.Load` does
 * (`apps/cli-go/pkg/config/config.go:653-668`), for commands that run a
 * pg_dump / shadow-DB container (`db dump`, declarative). Promote/extend this if
 * the full service-image resolution is ever needed.
 *
 * The image tags are baked into the Go binary via the embedded Dockerfile
 * (`pkg/config/templates/Dockerfile`, parsed into `config.Images`), so they are
 * mirrored here as constants rather than read from any file.
 */

// `FROM supabase/postgres:17.6.1.136 AS pg` (the embedded Dockerfile `pg` stage).
const LEGACY_PG_IMAGE = "supabase/postgres:17.6.1.136";
// `pkg/config/constants.go:12-14`.
const LEGACY_PG14 = "supabase/postgres:14.1.0.89";
const LEGACY_PG15 = "supabase/postgres:15.8.1.085";

/** `pkg/config/utils.go:81` — replace everything after the first `:` with `tag`. */
function replaceImageTag(image: string, tag: string): string {
  const index = image.indexOf(":");
  return image.slice(0, index + 1) + tag.trim();
}

/**
 * Go's `VersionCompare` (`pkg/config/config.go`): compares semver, treating a
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
  // OrioleDB override (Go's `config.Validate`, `pkg/config/config.go:876-880`): on a
  // 15/17 project with `experimental.orioledb_version` set, the Postgres image is
  // replaced with the OrioleDB tag, taking precedence over the default/pinned image.
  if (
    orioledbVersion !== undefined &&
    orioledbVersion.length > 0 &&
    (majorVersion === 15 || majorVersion === 17)
  ) {
    return versionCompare(orioledbVersion, "15.1.1.13") > 0
      ? `supabase/postgres:${orioledbVersion}-orioledb`
      : `supabase/postgres:orioledb-${orioledbVersion}`;
  }
  let image = LEGACY_PG_IMAGE;
  switch (majorVersion) {
    case 13:
      image = LEGACY_PG15;
      break;
    case 14:
      image = LEGACY_PG14;
      break;
    case 15:
      image = LEGACY_PG15;
      break;
    default:
      break;
  }
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
        image = replaceImageTag(LEGACY_PG_IMAGE, pinned);
      }
    }
  }
  return image;
});
