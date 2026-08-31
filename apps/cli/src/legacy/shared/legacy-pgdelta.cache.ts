import { createHash } from "node:crypto";
import { Clock, Effect, type FileSystem, Option, type Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";

import {
  LegacyNetworkIdFlag,
  legacyResolveDebugWithProjectEnv,
} from "../../shared/legacy/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import {
  type LegacyBaselineTomlConfig,
  type LegacyDbTomlValues,
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "./legacy-db-config.toml-read.ts";
import { legacyWalkSqlFiles } from "./legacy-glob.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "./db-bootstrap/local-container-inputs.ts";
import { legacyWaitForShadowReady } from "./db-bootstrap/health-check.ts";
import {
  legacyWithShadowDatabase,
  type LegacyShadowAcquiredHandle,
  type LegacyShadowCacheOpts,
} from "./db-bootstrap/shadow-cache.ts";
import {
  legacySetupShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
  type LegacyShadowSetupInput,
} from "./db-bootstrap/shadow-database.ts";
import { legacyPgDeltaTempPath } from "./legacy-pgdelta.paths.ts";
import { legacyCompareUtf8Bytes } from "./legacy-glob.ts";
import { LegacyMigrationsReadError } from "./legacy-migration.errors.ts";
import { legacyToPostgresURL } from "./legacy-postgres-url.ts";
import {
  type LegacyPgDeltaContext,
  legacyExportCatalogPgDelta,
  legacyResolvePgDeltaProjectId,
} from "./legacy-pgdelta.ts";
import { legacyApplyDeclarativePgDelta } from "../commands/db/shared/legacy-pgdelta.apply.ts";
import { LegacyDbConfigLoadError } from "./legacy-db-config.errors.ts";
import { legacyPrepareShadowSource } from "../commands/db/shared/legacy-shadow-source.ts";

type Spawner = ChildProcessSpawnerType["Service"];

/**
 * Declarative catalog-cache key builders + on-disk catalog resolution, based on
 * Go (`apps/cli-go/internal/db/declarative/declarative.go` +
 * `internal/db/pgcache/cache.go`). Byte-stable keys still matter for this CLI's
 * own cache reuse under `supabase/.temp/pgdelta/` across runs — a drifting key
 * would silently miss (re-provision) or over-hit (reuse a stale snapshot). Keys
 * now intentionally diverge from the old Go binary for configs with
 * `api.auto_expose_new_tables` unset: the effective value flipped to `true`, the
 * baked cluster genuinely differs, and reusing a Go-era snapshot would mean
 * reusing one with revoked grants.
 *
 * Beyond the pure key/path builders, this file also owns the migrations-catalog
 * RESOLUTION path for both `db diff --from/--to migrations` and `db schema
 * declarative sync` ({@link legacyResolveMigrationsCatalogRef},
 * {@link legacyGetMigrationsCatalogRef}) — including NATIVE shadow-database
 * provisioning/removal (CLI-1956, {@link exportViaShadowCatalog}, the same
 * `legacyCreateShadowDatabase`/`legacyPrepareShadowSource`/
 * `legacyRemoveShadowDatabase` primitives `db diff`/`db pull` use for their own
 * shadow — no seam/subprocess involved) and the "Creating shadow database..."
 * stderr side effect the latter prints on a cache miss. It is not a pure module.
 */

const CATALOG_PREFIX_PATTERN = /[^a-zA-Z0-9._-]+/g;
const CATALOG_RETENTION_COUNT = 2;
// `pkg/migration/list.go` — `<14-digit>_init.sql` first migrations (pre-2021-12-09) are skipped.
const INIT_SCHEMA_PATTERN = /([0-9]{14})_init\.sql/;
const INIT_SCHEMA_CUTOFF = 20211209000000;
// `pkg/migration/file.go` — valid migration filenames.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;
// `internal/utils/misc.go` — `ProjectHostPattern`, matches a direct `db.<ref>.supabase.{co,red}` host.
const PROJECT_HOST_PATTERN = /^(db\.)([a-z]{20})\.supabase\.(co|red)$/;

/** Inputs that shape the legacy `WithLegacyPgNetBaseline` shadow setup. */
export interface LegacySetupInputs {
  /** The resolved Postgres image (`Config.Db.Image`); only its tag is used. */
  readonly image: string;
  readonly majorVersion: number;
  readonly authEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly realtimeEnabled: boolean;
  /** Effective `api.auto_expose_new_tables` (unset and `true` both → `true`). */
  readonly autoExpose: boolean;
  /** `[db.vault]` secret names (sorted before hashing). */
  readonly vaultNames: ReadonlyArray<string>;
  /** Contents of `supabase/roles.sql` (empty string when absent). */
  readonly rolesSql: string;
}

/** Mirrors Go's `sanitizedCatalogPrefix` (`declarative.go:765`). */
export function legacySanitizedCatalogPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return "local";
  return trimmed.replace(CATALOG_PREFIX_PATTERN, "-");
}

/**
 * Mirrors Go's `pgcache.CatalogPrefixFromConfig` (`pgcache/cache.go`): `"local"`
 * for the local dev database, the project ref for a direct `db.<ref>.supabase.*`
 * host, else a stable `url-<sha256[:12]>` derived from the connection.
 */
export function legacyCatalogPrefixFromConfig(
  conn: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
  },
  isLocal: boolean,
): string {
  if (isLocal) return "local";
  const match = PROJECT_HOST_PATTERN.exec(conn.host);
  if (match?.[2] !== undefined) return match[2];
  const key = `${conn.user}@${conn.host}:${conn.port}/${conn.database}`;
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return `url-${digest.slice(0, 12)}`;
}

/** Mirrors Go's `baselineVersionToken` (`declarative.go:665`): the image tag, or `pg<major>`. */
export function legacyBaselineVersionToken(image: string, majorVersion: number): string {
  let tag = image.trim();
  const colon = tag.lastIndexOf(":");
  if (colon >= 0 && colon + 1 < tag.length) tag = tag.slice(colon + 1);
  if (tag.trim().length === 0) tag = `pg${majorVersion}`;
  return tag.replace(CATALOG_PREFIX_PATTERN, "-");
}

const boolToken = (value: boolean) => (value ? "true" : "false");

/**
 * Mirrors Go's `setupInputsToken` (`declarative.go:688`): a 12-char hex digest of
 * the platform-baseline inputs. The hashed byte sequence reproduces Go's
 * `fmt.Fprintln`/`fmt.Fprintf` writes exactly so the key matches the Go binary's.
 */
export function legacySetupInputsToken(inputs: LegacySetupInputs): string {
  const versionToken = legacyBaselineVersionToken(inputs.image, inputs.majorVersion);
  let payload = `${versionToken}\n`;
  payload += `auth=${boolToken(inputs.authEnabled)} storage=${boolToken(
    inputs.storageEnabled,
  )} realtime=${boolToken(inputs.realtimeEnabled)}\n`;
  payload += `auto_expose_new_tables=${boolToken(inputs.autoExpose)}\n`;
  for (const name of [...inputs.vaultNames].sort()) payload += `vault=${name}\n`;
  payload += inputs.rolesSql;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}

/** Mirrors Go's `baselineCatalogKey` (`declarative.go:729`): `<versionToken>-<setupToken>`. */
export function legacyBaselineCatalogKey(inputs: LegacySetupInputs): string {
  return `${legacyBaselineVersionToken(inputs.image, inputs.majorVersion)}-${legacySetupInputsToken(
    inputs,
  )}`;
}

/**
 * Resolves {@link LegacySetupInputs} from the caller's already-loaded db config:
 * the resolved Postgres image, and `supabase/roles.sql`'s content (empty when
 * absent, mirroring Go's `errors.Is(err, os.ErrNotExist)` tolerance in
 * `setupInputsToken`, `apps/cli-go/internal/db/declarative/declarative.go:711-714`).
 * Callers pass `toml.baseline` (`legacy-db-config.toml-read.ts`'s
 * `LegacyBaselineTomlConfig`, already exactly this cache-key subset) verbatim.
 */
export const legacyResolveSetupInputs = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  majorVersion: number,
  orioledbVersion: string | undefined,
  baseline: LegacyBaselineTomlConfig,
) {
  const { image } = yield* legacyResolveDbImage(fs, path, workdir, majorVersion, orioledbVersion);
  const rolesPath = path.join(workdir, "supabase", "roles.sql");
  const rolesSql = yield* fs
    .readFileString(rolesPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
  return {
    image,
    majorVersion,
    authEnabled: baseline.authEnabled,
    storageEnabled: baseline.storageEnabled,
    realtimeEnabled: baseline.realtimeEnabled,
    autoExpose: Option.getOrElse(baseline.apiAutoExposeNewTables, () => true),
    vaultNames: baseline.vaultNames,
    rolesSql,
  } satisfies LegacySetupInputs;
});

/** Mirrors Go's `declarativeCatalogCacheKey` (`declarative.go:753`): `<setupToken>-<schemaHash>`. */
export function legacyDeclarativeCatalogCacheKey(setupToken: string, schemaHash: string): string {
  return `${setupToken}-${schemaHash}`;
}

/**
 * Mirrors Go's `migrationsCatalogCacheKey` (`declarative.go:765`): `<setupToken>-
 * <migrationsHash>`. Used ONLY by {@link legacyGetMigrationsCatalogRef} (the
 * `db schema declarative sync` migrations source) — `db diff`'s explicit
 * `--from/--to migrations` uses a bare, setup-token-less hash instead (Go's
 * `resolveMigrationsCatalogRef`, `internal/db/diff/explicit.go:88`; see
 * {@link legacyResolveMigrationsCatalogRef}). These are deliberately two different
 * cache-key schemes over the same `catalog-local-migrations-*.json` filename
 * family, matching Go exactly (CLI-1959).
 */
export function legacyMigrationsCatalogCacheKey(
  setupToken: string,
  migrationsHash: string,
): string {
  return `${setupToken}-${migrationsHash}`;
}

/** `catalog-baseline-<key>.json` (`declarative.go:44`). */
export function legacyBaselineCatalogFileName(key: string): string {
  return `catalog-baseline-${key}.json`;
}

/** `catalog-<prefix>-declarative-<hash>-<ts>.json` (`declarative.go:46`). */
export function legacyDeclarativeCatalogFileName(
  prefix: string,
  hash: string,
  timestampMillis: number,
): string {
  return `catalog-${legacySanitizedCatalogPrefix(prefix)}-declarative-${hash}-${timestampMillis}.json`;
}

/**
 * Lists local migration file paths under `migrationsDir`. Mirrors Go's
 * `migration.ListLocalMigrations` (`pkg/migration/list.go:33`): entries are sorted by name — Go's
 * `fs.ReadDir` byte-wise UTF-8 order, via {@link legacyCompareUtf8Bytes}, not JS's default
 * UTF-16-code-unit `Array.prototype.sort()` — directories skipped, a deprecated
 * `<14-digit>_init.sql` first migration (pre-2021-12-09) is skipped, and names must match
 * `<digits>_*.sql`.
 *
 * Each skipped file emits a byte-exact stderr warning matching Go's
 * `fmt.Fprintf(os.Stderr, …)` (`list.go:45-53`) — same wording for both the
 * deprecated-init and misnamed-file cases. Because this is the shared lister,
 * the warning fires for the `db diff/pull/schema declarative` and pgcache paths
 * too, not only the `migration` commands, exactly as in Go.
 */
export const legacyListLocalMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const output = yield* Output;
  // Mirror Go's single `fs.ReadDir` (`pkg/migration/list.go:34-37`): only a
  // not-exist directory is "no migrations"; every other read error (the path is a
  // file → `ENOTDIR`, permission denied, …) aborts rather than silently letting
  // smart generate/sync believe there are no local migrations. Effect surfaces
  // "not found" as a `PlatformError` with a `SystemError` reason tagged `"NotFound"`.
  const names = yield* fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.fail(
            new LegacyMigrationsReadError({
              message: `failed to read directory: ${error.message}`,
            }),
          ),
    ),
  );
  if (names.length === 0) return [] as ReadonlyArray<string>;
  // Go's `fs.ReadDir` (`pkg/migration/list.go:34`) returns entries sorted byte-wise over each
  // name's UTF-8 encoding — NOT JS's default `Array.prototype.sort()`, which compares UTF-16 code
  // units and disagrees with byte/codepoint order for a supplementary-plane filename character
  // alongside a BMP private-use one (see {@link legacyCompareUtf8Bytes}'s own doc comment,
  // verified empirically there against both Go's `sort.Strings` and `os.ReadDir`). Left
  // uncorrected, such a migrations directory would replay in a different order than Go, and a
  // dependent migration could fail or produce a different shadow schema (review:
  // PRRT_kwDOErm0O86W3OyD).
  const sorted = [...names].sort(legacyCompareUtf8Bytes);
  const result: Array<string> = [];
  for (let index = 0; index < sorted.length; index++) {
    const name = sorted[index]!;
    const entryPath = path.join(migrationsDir, name);
    // Go's `os.ReadDir`/`DirEntry.IsDir()` (`pkg/migration/list.go:34-43`) classifies a
    // directory entry from its own type without following symlinks (verified empirically:
    // `DirEntry.IsDir()` reports `false` for a `.sql` symlink whose target is a directory) —
    // so a symlinked migration is never skipped as a directory in Go, only later, when
    // `ApplyMigrations` fails to read it as a regular file. `fs.stat` below follows
    // symlinks, so it would misclassify a symlink-to-directory as a plain directory and
    // silently skip it here instead. Check `readLink` (which only succeeds for a symlink)
    // first and skip the directory check entirely for symlinks, matching Go's `IsDir()`.
    const isSymlink = Option.isSome(yield* fs.readLink(entryPath).pipe(Effect.option));
    if (!isSymlink) {
      const stat = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isSome(stat) && stat.value.type === "Directory") continue;
    }
    if (index === 0) {
      const init = INIT_SCHEMA_PATTERN.exec(name);
      if (init !== null && Number(init[1]) < INIT_SCHEMA_CUTOFF) {
        yield* output.raw(
          `Skipping migration ${name}... (replace "init" with a different file name to apply this migration)\n`,
          "stderr",
        );
        continue;
      }
    }
    if (!MIGRATE_FILE_PATTERN.test(name)) {
      yield* output.raw(
        `Skipping migration ${name}... (file name must match pattern "<timestamp>_name.sql")\n`,
        "stderr",
      );
      continue;
    }
    result.push(entryPath);
  }
  return result as ReadonlyArray<string>;
});

/**
 * Mirrors Go's `pgcache.HashMigrations` (`pgcache/cache.go`): for each local
 * migration (in list order), hash its `workdir`-relative path then its
 * contents. Returns full hex.
 */
export const legacyHashMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  migrationsDir: string,
) {
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  const hash = createHash("sha256");
  for (const filePath of migrations) {
    const contents = yield* fs.readFile(filePath);
    hash.update(path.relative(workdir, filePath), "utf8");
    hash.update(contents);
  }
  return hash.digest("hex");
});

/**
 * Walk the declarative dir for regular `.sql` files, byte-sort by relative path, and hash
 * each file's forward-slash relative path then its contents. Returns full hex.
 *
 * Uses {@link legacyWalkSqlFiles} for the traversal, which gives three properties this cache
 * key depends on: the walk is strict (a readDirectory/stat failure fails the hash rather than
 * shrinking it into a possible stale-cache collision), it never follows symlinks (a directory
 * symlink pointing at an ancestor would otherwise loop the walk forever, and symlinked `.sql`
 * files are excluded like non-regular files), and each directory level plus the final list is
 * byte-sorted so the key is stable across platforms. A missing root is the one tolerated
 * case (deterministic empty hash; callers gate on the dir existing before catalog export) —
 * `fs.exists` maps only not-found to `false`, so any other root failure (permissions, I/O)
 * propagates instead of masquerading as an empty tree.
 *
 * Deliberate divergence from the old Go walk: a declarative root that is ITSELF a directory
 * symlink is followed (entries beneath it still aren't). Go's lstat-rooted walk hashed such a
 * root as an empty tree while the apply path followed the link and applied the target's files —
 * a hash≠apply mismatch of exactly the stale-catalog class this function guards against. The
 * cost is a one-time cache miss for symlinked-root setups.
 */
export const legacyHashDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  _path: Path.Path,
  declarativeDir: string,
) {
  const exists = yield* fs.exists(declarativeDir);
  const files = exists ? yield* legacyWalkSqlFiles(fs, declarativeDir, "") : [];
  const hash = createHash("sha256");
  for (const rel of files) {
    const contents = yield* fs.readFile(`${declarativeDir}/${rel}`);
    hash.update(rel, "utf8");
    hash.update(contents);
  }
  return hash.digest("hex");
});

const parseCatalogTimestamp = (name: string): Option.Option<number> => {
  if (!name.endsWith(".json")) return Option.none();
  const raw = name.slice(0, -".json".length);
  const idx = raw.lastIndexOf("-");
  if (idx < 0 || idx + 1 >= raw.length) return Option.none();
  const ts = Number(raw.slice(idx + 1));
  return Number.isInteger(ts) ? Option.some(ts) : Option.none();
};

/**
 * Mirrors Go's `ensureTempDir` + `ReadDir` pairing (`pgcache/cache.go`,
 * `declarative.go`): the temp dir's existence is already guaranteed by the
 * `MkdirAll` that runs before every write into it, so Go's `ReadDir` only ever
 * needs to tolerate a genuinely missing directory (a cache that was never
 * written to) — every OTHER read failure (e.g. permission denied) propagates,
 * same as {@link legacyListLocalMigrations} above. Swallowing every failure
 * (as an earlier version of this did) let a real read error silently look like
 * "no cached catalogs", which both bypasses catalog resolution's cache HIT and
 * — for cleanup's caller — bypasses the retention limit indefinitely, since
 * the caller's own warning path never fires without a propagated failure.
 */
const listJsonEntries = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, tempDir: string) {
  return yield* fs.readDirectory(tempDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.fail(
            new LegacyMigrationsReadError({
              message: `failed to read directory: ${error.message}`,
            }),
          ),
    ),
  );
});

/**
 * Shared "highest suffixed timestamp wins" scan behind both
 * {@link legacyResolveDeclarativeCatalogPath} and {@link legacyResolveMigrationCatalogPath}:
 * of every `<familyPrefix><ts>.json` entry in `tempDir`, returns the path with the
 * highest `ts`. Mirrors both Go's `resolveDeclarativeCatalogPath`
 * (`declarative.go:578`) and `pgcache.ResolveMigrationCatalogPath`
 * (`internal/db/pgcache/cache.go:112-149`), which share this exact scan over their
 * own filename family — only the family prefix differs between callers.
 */
const resolveLatestByFamily = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  familyPrefix: string,
) {
  const entries = yield* listJsonEntries(fs, tempDir);
  let latestPath = Option.none<string>();
  let latest = -1;
  for (const name of entries) {
    if (!name.startsWith(familyPrefix) || !name.endsWith(".json")) continue;
    const stamp = Number(name.slice(familyPrefix.length, -".json".length));
    if (Number.isInteger(stamp) && stamp > latest) {
      latest = stamp;
      latestPath = Option.some(path.join(tempDir, name));
    }
  }
  return latestPath;
});

/**
 * Resolves the newest cached declarative catalog for `(hash, prefix)`. Mirrors
 * Go's `resolveDeclarativeCatalogPath` (`declarative.go:578`): of all
 * `catalog-<prefix>-declarative-<hash>-<ts>.json`, returns the highest `ts`.
 */
export const legacyResolveDeclarativeCatalogPath = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  hash: string,
  prefix: string,
) {
  return yield* resolveLatestByFamily(
    fs,
    path,
    tempDir,
    `catalog-${legacySanitizedCatalogPrefix(prefix)}-declarative-${hash}-`,
  );
});

const cleanupOldCatalogsByFamily = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  familyPrefix: string,
) {
  const entries = yield* listJsonEntries(fs, tempDir);
  const files = entries
    .filter((name) => name.startsWith(familyPrefix) && name.endsWith(".json"))
    .map((name) => ({ name, timestamp: Option.getOrElse(parseCatalogTimestamp(name), () => 0) }))
    .sort((a, b) =>
      b.timestamp === a.timestamp ? (a.name > b.name ? -1 : 1) : b.timestamp - a.timestamp,
    );
  // Removal failures propagate: retention silently not being enforced would let
  // snapshots accumulate indefinitely while every run reports a successful write.
  for (let index = CATALOG_RETENTION_COUNT; index < files.length; index++) {
    yield* fs.remove(path.join(tempDir, files[index]!.name));
  }
});

/**
 * Removes all but the newest `catalogRetentionCount` declarative catalogs for a
 * prefix family. Mirrors Go's `cleanupOldDeclarativeCatalogs` (`declarative.go:610`).
 */
export const legacyCleanupOldDeclarativeCatalogs = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
) {
  yield* cleanupOldCatalogsByFamily(
    fs,
    path,
    tempDir,
    `catalog-${legacySanitizedCatalogPrefix(prefix)}-declarative-`,
  );
});

/**
 * Removes all but the newest `catalogRetentionCount` migrations catalogs for a
 * prefix family. Mirrors Go's `pgcache.CleanupOldMigrationCatalogs` (`pgcache/cache.go`).
 */
export const legacyCleanupOldMigrationCatalogs = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
) {
  yield* cleanupOldCatalogsByFamily(
    fs,
    path,
    tempDir,
    `catalog-${legacySanitizedCatalogPrefix(prefix)}-migrations-`,
  );
});

/** `catalog-<prefix>-migrations-<hash>-<ts>.json` (Go's `migrationsCatalogName`, `pgcache/cache.go`). */
export function legacyMigrationCatalogFileName(
  prefix: string,
  hash: string,
  timestampMillis: number,
): string {
  return `catalog-${legacySanitizedCatalogPrefix(prefix)}-migrations-${hash}-${timestampMillis}.json`;
}

/**
 * Resolves the newest cached migrations catalog for `(hash, prefix)`. Mirrors
 * Go's `pgcache.ResolveMigrationCatalogPath` (`internal/db/pgcache/cache.go:112-149`).
 * Go's fallback to a pre-timestamp legacy filename (`catalog-<prefix>-migrations-
 * <hash>.json`, no `-<ts>` suffix) is intentionally NOT replicated: nothing in the
 * Go tree writes that name any more — `pgcache.MigrationCatalogPath` has always
 * produced the timestamped form since the fallback was added in the same commit
 * (CLI-1959 go-parity-auditor finding) — so it is unreachable dead code on both
 * sides.
 */
export const legacyResolveMigrationCatalogPath = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  hash: string,
  prefix: string,
) {
  return yield* resolveLatestByFamily(
    fs,
    path,
    tempDir,
    `catalog-${legacySanitizedCatalogPrefix(prefix)}-migrations-${hash}-`,
  );
});

/**
 * Writes a migrations-catalog snapshot to `<tempDir>/catalog-<prefix>-migrations-<hash>-<ts>.json`
 * and prunes older snapshots for the same `(prefix)` family. Mirrors Go's
 * `pgcache.WriteMigrationCatalogSnapshot` (`pgcache/cache.go`).
 */
export const legacyWriteMigrationCatalogSnapshot = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
  hash: string,
  snapshot: string,
  timestampMillis: number,
) {
  yield* fs.makeDirectory(tempDir, { recursive: true }).pipe(Effect.ignore);
  const filePath = path.join(
    tempDir,
    legacyMigrationCatalogFileName(prefix, hash, timestampMillis),
  );
  yield* fs.writeFileString(filePath, snapshot);
  yield* legacyCleanupOldMigrationCatalogs(fs, path, tempDir, prefix);
  return filePath;
});

/**
 * Best-effort caches the migrations catalog for pg-delta after a successful
 * `db push` migration apply. Mirrors Go's `pgcache.TryCacheMigrationsCatalog`
 * (`pgcache/cache.go`); `enabled` is resolved by the caller since it depends on
 * already-loaded config. Reuses `legacyExportCatalogPgDelta` (Go's correct
 * `diff/pgdelta.go` `ExportCatalogPgDelta`) rather than porting a second copy,
 * so this can't reintroduce the `/workspace` mount bug `pgcache/cache.go` had
 * (supabase/cli#5921).
 *
 * The snapshot's timestamp is read from `Clock` HERE — after `legacyHashMigrations`
 * and `legacyExportCatalogPgDelta` (the network round-trip) have both resolved,
 * immediately before the write — never accepted as a caller-supplied parameter.
 * This mirrors Go's own call order exactly: `TryCacheMigrationsCatalog`
 * (`pgcache/cache.go:71-91`) resolves `hash` and `snapshot` FIRST, and only THEN
 * calls `WriteMigrationCatalogSnapshot`, which itself reads `time.Now().UTC()`
 * (`pgcache/cache.go:151-163`) — i.e. Go's clock read happens LAST, right before
 * the file write, not before the export. A caller capturing the timestamp before
 * calling this function (review CLI-1958) would race a concurrent cache write
 * from another process: Go would order the two snapshots by real write-time, but
 * the early-captured timestamp could sort the wrong one as "latest" during
 * catalog resolution/retention (`legacyResolveMigrationCatalogPath`,
 * `legacyCleanupOldMigrationCatalogs`).
 */
export const legacyTryCacheMigrationsCatalog = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  params: {
    readonly enabled: boolean;
    readonly targetUrl: string;
    readonly conn: {
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly database: string;
    };
    readonly isLocal: boolean;
    readonly migrationsDir: string;
  },
) {
  if (!params.enabled) return;
  const prefix = legacyCatalogPrefixFromConfig(params.conn, params.isLocal);
  const hash = yield* legacyHashMigrations(fs, path, ctx.cwd, params.migrationsDir);
  const snapshot = yield* legacyExportCatalogPgDelta(ctx, {
    targetRef: params.targetUrl,
    role: "postgres",
  });
  const nowMillis = yield* Clock.currentTimeMillis;
  yield* legacyWriteMigrationCatalogSnapshot(
    fs,
    path,
    legacyPgDeltaTempPath(path, ctx.cwd),
    prefix,
    hash,
    snapshot,
    nowMillis,
  );
});

/** The spawner + already-built local container inputs {@link exportViaShadowCatalog} needs. */
interface LegacyShadowCatalogInputs {
  readonly spawner: ChildProcessSpawnerType["Service"];
  readonly localInputs: LegacyLocalDbContainerInputs;
}

/**
 * Builds the {@link LegacyShadowCatalogInputs} {@link exportViaShadowCatalog} needs — the SAME
 * second `@supabase/config` load (`legacyBuildLocalDbContainerInputs`) `db diff`/`db pull` run
 * before their own "Creating shadow database..." banner (`diff.handler.ts`'s `localInputs`
 * build, see that call site's doc comment). Split out from `exportViaShadowCatalog` itself so
 * {@link legacyGetMigrationsCatalogRef} can run it BEFORE printing its own banner: this load can
 * fail on its own (e.g. an enabled API TLS's unreadable cert/key files, which `toml` never
 * reads), and Go's config loading — ALL of it, including this validation — runs once in the
 * root `PersistentPreRunE`, strictly before `declarative.go`'s `createShadowContainer` ever
 * prints "Creating shadow database..." (`declarative.go:490`). Building it as an implicit side
 * effect of `exportViaShadowCatalog` (called only after the banner already printed) would
 * surface that failure AFTER the banner instead, unlike Go. {@link legacyResolveMigrationsCatalogRef}
 * has no such banner, so calling this immediately before `exportViaShadowCatalog` on its own
 * cache-miss path is harmless there too — it only ever changes when a pre-existing,
 * unconditional build runs relative to a print that never happens on that path.
 */
const legacyBuildShadowCatalogInputs = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  toml: LegacyDbTomlValues,
  provisionParams: { readonly projectRef?: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  // Go's equivalent stderr writer for the shadow's one-shot setup jobs is
  // `utils.GetDebugLogger()` = `viper.GetBool("DEBUG")` (`internal/utils/logger.go:11`),
  // which also honors `SUPABASE_DEBUG` via `AutomaticEnv` — NOT the bare `--debug` pflag
  // value. `legacyResolveDebugWithProjectEnv` reproduces that (plus the project `.env`
  // Go's `loadNestedEnv` has already `os.Setenv`'d into the process by this point).
  const debug = yield* legacyResolveDebugWithProjectEnv(toml.projectEnv);
  const localInputs = yield* legacyBuildLocalDbContainerInputs(
    spawner,
    ctx.cwd,
    networkIdFlag,
    runtimeInfo.platform,
    debug,
    provisionParams.projectRef,
    toml.remoteOverrideKeys,
  );
  return { spawner, localInputs } satisfies LegacyShadowCatalogInputs;
});

/**
 * Shared shadow-provision → pg-delta export → persist → cleanup mechanics behind
 * both {@link legacyResolveMigrationsCatalogRef} and {@link legacyGetMigrationsCatalogRef}
 * on a cache miss. Provisions the shadow via the SAME native primitives `db
 * diff`/`db pull` use for their own diff-source shadow (CLI-1956,
 * `legacyCreateShadowDatabase` + `legacyPrepareShadowSource` +
 * `legacyRemoveShadowDatabase`, `commands/db/shared/legacy-shadow-source.ts`) —
 * NOT the retired `db __shadow` hidden CLI subcommand, which was only ever a
 * TS-facing IPC shim over these same Go functions. This is in fact TRUER Go
 * parity than the shim it replaces: Go's own two callers of this mechanics —
 * `resolveMigrationsCatalogRef` (`apps/cli-go/internal/db/diff/explicit.go:88-126`)
 * and `getMigrationsCatalogRef`'s `createShadow`/`createShadowContainer`
 * (`apps/cli-go/internal/db/declarative/declarative.go:368-430,487-506`) — both
 * call `diff.CreateShadowDatabase` + `diff.MigrateShadowDatabase` (via
 * `start.WaitForHealthyService`) DIRECTLY, in-process, never through a CLI
 * subcommand. `legacyPrepareShadowSource` is called with `targetLocal: false` +
 * `usePgDelta: false`, which skips its ENTIRE declarative-schema-override branch
 * (Go's local-target `PrepareShadowSource`/`shadow.go:37-91` branch) — neither Go
 * function above ever takes that branch either, since neither has a "target" at
 * all; they only ever provision + migrate + export.
 *
 * Exports the shadow's catalog via the already-native {@link legacyExportCatalogPgDelta}
 * (the same edge-runtime script Go's own `ExportCatalogPgDelta` runs), hands the
 * snapshot to `persist` to decide where it lands on disk, then removes the shadow
 * (`Effect.acquireUseRelease`'s release phase, once the `use` phase below has run —
 * success or failure alike) — matching Go's `defer utils.DockerRemove(shadow)`
 * immediately after creation, and `diff.handler.ts`/`pull.handler.ts`'s own
 * `acquire`=create/`use`=prepare+diff/`release`=remove shape for the exact same
 * interruptibility reason (see `legacyPrepareShadowSource`'s own doc comment:
 * creation runs inside `acquireUseRelease`'s uninterruptible `acquire`, while the
 * health-wait/migrate sequence stays in the interruptible `use` phase, so a SIGINT
 * during either can still land while the shadow is still reliably torn down). This
 * is NOT an unconditional guarantee, though — see `legacyCreateShadowDatabase`'s own
 * doc comment (`shadow-database.ts`) for the still-present, deliberate-Go-parity
 * leak window when `acquire` itself (container creation) fails partway through.
 *
 * The persisted path is made relative to `ctx.cwd` before returning: every caller
 * feeds this ref into pg-delta's edge-runtime scripts as SOURCE/TARGET, which
 * prefix a bare (non-postgres://) ref with `/workspace/` — matching the container
 * bind `${ctx.cwd}:/workspace` (`legacyPgDeltaContainerRef`, `legacy-pgdelta.ts:
 * 100-103`). Go's equivalent (`pgcache.WriteMigrationCatalogSnapshot`) is only
 * ever built from `utils.TempDir`, a workdir-RELATIVE constant (Go chdirs into the
 * workdir first), so the ref it returns is relative too; return the same shape
 * here rather than the absolute host path `persist` builds internally. The two
 * public functions differ only in their cache-decision and `persist`'s
 * cache-write logic, not in this mechanics.
 *
 * `toml` is the caller's own already-loaded/remote-merged `config.toml` read
 * (`legacyReadDbToml`'s result) — used, together with the caller-supplied
 * {@link LegacyShadowCatalogInputs} (built by {@link legacyBuildShadowCatalogInputs}),
 * to derive the shadow's own container spec (image, JWT secret, root key,
 * `db.settings`, service enabled-for-setup flags) exactly like `db diff`/`db pull`
 * do for their own shadow. The build is NOT performed in here — see
 * {@link legacyBuildShadowCatalogInputs}'s own doc comment for why a caller that
 * prints a "Creating shadow database..." banner first must build it BEFORE that
 * print, not have it built implicitly as a side effect of calling this function.
 */
/**
 * A provisioned shadow, ready to export a pg-delta catalog from. `sourceUrl` is the only field
 * {@link exportViaShadowCatalog} itself reads — {@link legacyPrepareShadowSource}'s richer
 * `LegacyShadowSourceResult` (used by the migrations-catalog `provision` below) satisfies this
 * structurally, so callers that provision a bare platform-baseline/declarative shadow (no
 * migrations-catalog `targetUrlOverride` concept) can return just this shape.
 */
interface LegacyProvisionedShadow {
  readonly sourceUrl: string;
}

/**
 * Shared shadow-provision → pg-delta export → persist → cleanup mechanics behind every
 * `exportCatalog` composition in this file: {@link legacyResolveMigrationsCatalogRef} and
 * {@link legacyGetMigrationsCatalogRef} below (migrations catalogs, via `provision =
 * legacyPrepareShadowSource`, which additionally applies local migrations/declarative overrides),
 * and {@link legacyExportBaselineCatalogRef}/{@link legacyExportDeclarativeCatalogRef} (the native
 * `LegacyDeclarativeSeam.exportCatalog` compositions, via a `provision` that runs ONLY the
 * platform baseline — see those functions' own doc comments for why they must NOT reuse
 * `legacyPrepareShadowSource`, which applies local migrations). `provision` is the one part of the
 * shadow lifecycle that genuinely differs between callers; everything else (create, export,
 * persist, remove) is identical, so it is parameterized here rather than duplicated — see this
 * function's own git history for the sibling-function shape this replaced.
 */
const exportViaShadowCatalog = <E, R, EP = never, RP = never>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  toml: LegacyDbTomlValues,
  built: LegacyShadowCatalogInputs,
  provision: (
    spawner: Spawner,
    handle: LegacyShadowAcquiredHandle,
    shadowInput: LegacyShadowSetupInput<LegacyDbConfigLoadError>,
  ) => Effect.Effect<LegacyProvisionedShadow, EP, RP>,
  persist: (snapshot: string) => Effect.Effect<string, E, R>,
  // No default: every caller must declare its provisioner's effective webhooks policy.
  shadowCacheOpts: LegacyShadowCacheOpts,
) =>
  Effect.gen(function* () {
    const { spawner, localInputs } = built;
    const resolvedImage = yield* localInputs.resolvePostgresImage;
    const shadowInput = legacyShadowRunInputFromLocalContainerInputs(
      localInputs,
      resolvedImage,
      toml,
      fs,
      path,
    );
    // `legacyWithShadowDatabase` (`db-bootstrap/shadow-cache.ts`) rather than a bare
    // `legacyCreateShadowDatabase`/`legacyRemoveShadowDatabase` pair — see its doc comment: with
    // `SUPABASE_SHADOW_CACHE` unset it IS that pair (identical Docker argv, identical labels), and
    // with it set a catalog cache miss restores a key-matching PGDATA snapshot into the fresh
    // shadow instead of paying the full cold provision — the same swap `db diff`/`db pull`'s own
    // call sites make. `shadowCacheOpts` carries `sync --no-cache`'s bypass and the
    // caller's effective Webhooks policy — see `LegacyShadowCacheOpts`.
    const written = yield* legacyWithShadowDatabase(
      spawner,
      shadowInput,
      (handle) =>
        Effect.gen(function* () {
          const shadow = yield* provision(spawner, handle, shadowInput);
          const snapshot = yield* legacyExportCatalogPgDelta(ctx, {
            targetRef: shadow.sourceUrl,
            role: "postgres",
          });
          return yield* persist(snapshot);
        }),
      shadowCacheOpts,
    );
    return path.relative(ctx.cwd, written);
  });

/**
 * {@link exportViaShadowCatalog}'s `provision` for the migrations-catalog callers
 * ({@link legacyResolveMigrationsCatalogRef}/{@link legacyGetMigrationsCatalogRef}): extends the
 * base shadow-setup input with the pg-delta/declarative-override fields
 * {@link legacyPrepareShadowSource} needs (`targetLocal: false`/`usePgDelta: false` — neither
 * caller has a "target" at all, they only ever provision + migrate + export), then applies local
 * migrations via `legacyMigrateShadowDatabase`.
 */
const legacyProvisionMigrationsShadow = (
  ctx: LegacyPgDeltaContext,
  toml: LegacyDbTomlValues,
  spawner: Spawner,
  handle: LegacyShadowAcquiredHandle,
  shadowInput: LegacyShadowSetupInput<LegacyDbConfigLoadError>,
) =>
  legacyPrepareShadowSource(spawner, handle, {
    ...shadowInput,
    targetLocal: false,
    usePgDelta: false,
    schemaPaths: toml.schemaPathPatterns,
    pgDelta: toml.pgDelta,
    ctx,
  });

/**
 * Resolves the pg-delta migrations-catalog ref for `db diff`'s explicit
 * `--from migrations` / `--to migrations` target — the native replacement for
 * the hidden Go seam `db schema declarative __catalog --mode migrations` this
 * call site used to shell out to (CLI-1959). Mirrors Go's
 * `resolveMigrationsCatalogRef` (`apps/cli-go/internal/db/diff/explicit.go:88-126`)
 * EXACTLY — not {@link legacyGetMigrationsCatalogRef} below, which backs a
 * different Go function (`declarative.go`'s `getMigrationsCatalogRef`, used by
 * `db schema declarative sync`). The two diverge on purpose: this one uses a
 * BARE migrations-content hash (no setup-inputs token — `explicit.go:89`'s
 * `pgcache.HashMigrations`), always consults the cache (`db diff` has no
 * `--no-cache` flag on this path), has no zero-migrations/baseline special case,
 * and prints no "Creating shadow database..." line (Go calls the shadow
 * primitives directly, without `DiffDatabase`'s own progress line).
 *
 * On a cache miss, the shadow-provision/export/persist/cleanup mechanics are
 * shared with {@link legacyGetMigrationsCatalogRef} via {@link exportViaShadowCatalog}
 * — see its doc comment. The catalog is cached with
 * {@link legacyWriteMigrationCatalogSnapshot}. `toml` is the caller's own
 * already-loaded/remote-merged `config.toml` read, threaded through to
 * {@link exportViaShadowCatalog} for the shadow's own container spec (CLI-1956) —
 * see that function's doc comment.
 */
export const legacyResolveMigrationsCatalogRef = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  toml: LegacyDbTomlValues,
  params: { readonly projectRef?: string },
) {
  const tempDir = legacyPgDeltaTempPath(path, ctx.cwd);
  const migrationsDir = path.join(ctx.cwd, "supabase", "migrations");
  const hash = yield* legacyHashMigrations(fs, path, ctx.cwd, migrationsDir);
  const cached = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, hash, "local");
  if (Option.isSome(cached)) return path.relative(ctx.cwd, cached.value);

  const built = yield* legacyBuildShadowCatalogInputs(ctx, toml, params);
  return yield* exportViaShadowCatalog(
    fs,
    path,
    ctx,
    toml,
    built,
    (spawner, handle, shadowInput) =>
      legacyProvisionMigrationsShadow(ctx, toml, spawner, handle, shadowInput),
    (snapshot) =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        return yield* legacyWriteMigrationCatalogSnapshot(
          fs,
          path,
          tempDir,
          "local",
          hash,
          snapshot,
          timestamp,
        );
      }),
    // `legacyProvisionMigrationsShadow` migrates via `legacyMigrateShadowDatabase`, which forces
    // `pg_net` on — the key must record that, not the config-following default (no `bypassCache`:
    // `db diff` has no `--no-cache` on this path).
    { webhooks: "enabled" },
  );
});

/** `catalog-nocache-migrations.json` — Go's `noCacheMigrationsCatalogPath` (`declarative.go:51`). */
const NO_CACHE_MIGRATIONS_CATALOG_NAME = "catalog-nocache-migrations.json";

/**
 * Resolves (and caches under `supabase/.temp/pgdelta/`) the pg-delta migrations
 * catalog — platform baseline + local migrations applied — for `db schema
 * declarative sync`'s diff SOURCE. The native replacement for the hidden Go seam
 * `db schema declarative __catalog --mode migrations` this call site used to
 * shell out to (CLI-1959). Mirrors Go's `getMigrationsCatalogRef`
 * (`apps/cli-go/internal/db/declarative/declarative.go:368-430`) — see
 * {@link legacyResolveMigrationsCatalogRef}'s doc comment for exactly how this
 * diverges from `db diff`'s bare-hash version: this one folds the setup-inputs
 * token into the cache key, special-cases zero local migrations by reusing/
 * writing the platform-baseline catalog, honors `--no-cache`, and prints
 * "Creating shadow database..." to stderr on a cache miss
 * (`declarative.go:490`, reached only when `createShadow` actually runs).
 *
 * On a cache miss, the shadow-provision/export/persist/cleanup mechanics are
 * shared with {@link legacyResolveMigrationsCatalogRef} via
 * {@link exportViaShadowCatalog} — see its doc comment. `toml` is the caller's
 * own already-loaded/remote-merged `config.toml` read, threaded through for the
 * shadow's own container spec (CLI-1956) — distinct from `setupInputs`, which is
 * only the cache-key/baseline-setup subset.
 */
export const legacyGetMigrationsCatalogRef = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  toml: LegacyDbTomlValues,
  setupInputs: LegacySetupInputs,
  params: { readonly noCache: boolean; readonly projectRef?: string },
) {
  const output = yield* Output;
  const tempDir = legacyPgDeltaTempPath(path, ctx.cwd);
  const migrationsDir = path.join(ctx.cwd, "supabase", "migrations");
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  const zeroMigrations = migrations.length === 0;

  // Built BEFORE the cache probes below, not just before the banner: this is a SECOND
  // `@supabase/config` load (`legacyBuildLocalDbContainerInputs`) whose failure (e.g. an
  // enabled API TLS's unreadable cert/key files) must surface regardless of cache state —
  // Go's config loading (all of it) ran once in the root `PersistentPreRunE`, strictly
  // before any catalog cache lookup and before `declarative.go`'s `createShadowContainer`
  // ever prints the banner (`declarative.go:490`). Probing first would make an invalid
  // project succeed or fail depending on whether a cache file happens to exist.
  const built = yield* legacyBuildShadowCatalogInputs(ctx, toml, params);

  const baselinePath = path.join(
    tempDir,
    legacyBaselineCatalogFileName(legacyBaselineCatalogKey(setupInputs)),
  );
  if (zeroMigrations && !params.noCache) {
    // `fs.exists` maps only not-found to `false`, so any other probe failure (permissions,
    // I/O under `.temp/pgdelta`) propagates — matching Go's `getMigrationsCatalogRef`
    // returning the `afero.Exists` error immediately, before any Docker side effect.
    const exists = yield* fs.exists(baselinePath);
    if (exists) return path.relative(ctx.cwd, baselinePath);
  }

  // Mirrors Go's unconditional `migrationsCatalogCacheKey` call (`declarative.go:393`),
  // which always runs — even on the zeroMigrations/noCache paths — since it is pure
  // and only unused there, not because it needs to run early for a side effect.
  const setupToken = legacySetupInputsToken(setupInputs);
  const migrationsHash = yield* legacyHashMigrations(fs, path, ctx.cwd, migrationsDir);
  const hash = legacyMigrationsCatalogCacheKey(setupToken, migrationsHash);

  if (!params.noCache && !zeroMigrations) {
    const cached = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, hash, "local");
    if (Option.isSome(cached)) return path.relative(ctx.cwd, cached.value);
  }

  yield* output.raw("Creating shadow database...\n", "stderr");
  return yield* exportViaShadowCatalog(
    fs,
    path,
    ctx,
    toml,
    built,
    (spawner, handle, shadowInput) =>
      legacyProvisionMigrationsShadow(ctx, toml, spawner, handle, shadowInput),
    (snapshot) =>
      Effect.gen(function* () {
        if (params.noCache) {
          yield* fs.makeDirectory(tempDir, { recursive: true }).pipe(Effect.ignore);
          const noCachePath = path.join(tempDir, NO_CACHE_MIGRATIONS_CATALOG_NAME);
          yield* fs.writeFileString(noCachePath, snapshot);
          return noCachePath;
        }
        if (zeroMigrations) {
          yield* fs.makeDirectory(tempDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.writeFileString(baselinePath, snapshot);
          return baselinePath;
        }
        const timestamp = yield* Clock.currentTimeMillis;
        return yield* legacyWriteMigrationCatalogSnapshot(
          fs,
          path,
          tempDir,
          "local",
          hash,
          snapshot,
          timestamp,
        );
      }),
    // `--no-cache` must also bypass the baseline snapshot, not just the catalog.
    { bypassCache: params.noCache, webhooks: "enabled" },
  );
});

/** `catalog-nocache-baseline.json` — Go's `noCacheBaselineCatalogPath` (`declarative.go:50`). */
export const LEGACY_NO_CACHE_BASELINE_CATALOG_NAME = "catalog-nocache-baseline.json";

/** `catalog-nocache-declarative.json` — Go's `noCacheDeclarativeCatalogPath` (`declarative.go:52`). */
export const LEGACY_NO_CACHE_DECLARATIVE_CATALOG_NAME = "catalog-nocache-declarative.json";

/** Writes a catalog snapshot to an exact path, creating `tempDir` first. Mirrors Go's `writeTempCatalog`/`ensureTempDir` pairing (`declarative.go:553-568`) for a caller that already knows its target file name (a keyed baseline catalog, or either mode's `--no-cache` file), unlike {@link legacyWriteMigrationCatalogSnapshot}/{@link legacyWriteDeclarativeCatalogSnapshot} below, which also derive the file name and prune older snapshots. */
const legacyWriteCatalogFile = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  tempDir: string,
  filePath: string,
  snapshot: string,
) {
  yield* fs.makeDirectory(tempDir, { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFileString(filePath, snapshot);
  return filePath;
});

/**
 * Writes a declarative-catalog snapshot to
 * `<tempDir>/catalog-<prefix>-declarative-<hash>-<ts>.json` and prunes older snapshots for the
 * same `(prefix, hash)` family (retention 2). The declarative sibling of
 * {@link legacyWriteMigrationCatalogSnapshot}; mirrors Go's `writeDeclarativeCatalogFromConfig`'s
 * own persist step (`declarative.go:463-485`).
 */
export const legacyWriteDeclarativeCatalogSnapshot = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
  hash: string,
  snapshot: string,
  timestampMillis: number,
) {
  const filePath = path.join(
    tempDir,
    legacyDeclarativeCatalogFileName(prefix, hash, timestampMillis),
  );
  yield* legacyWriteCatalogFile(fs, tempDir, filePath, snapshot);
  yield* legacyCleanupOldDeclarativeCatalogs(fs, path, tempDir, prefix);
  return filePath;
});

/**
 * {@link exportViaShadowCatalog}'s `provision` for {@link legacyExportBaselineCatalogRef}: the
 * platform baseline ONLY — no local migrations, no declarative apply. Mirrors Go's
 * `getGenerateBaselineCatalogRef` (`declarative.go:306-361`), which sets up the shadow via
 * `setupShadowDatabase` (the Supabase platform baseline, auth/storage/realtime) and nothing
 * else. Deliberately does NOT call {@link legacyPrepareShadowSource}/`legacyMigrateShadowDatabase`
 * — those apply local migrations, which would contaminate the baseline catalog Go's own
 * `baselineCatalogName` doc comment warns against (the baseline is reused as sync's diff
 * SOURCE when there are no local migrations, and as generate's diff SOURCE against a live
 * database — both need "platform baseline, nothing else").
 */
const legacyProvisionBaselineShadow = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  handle: LegacyShadowAcquiredHandle,
  shadowInput: LegacyShadowSetupInput<LegacyDbConfigLoadError>,
) =>
  Effect.gen(function* () {
    const connConfig: LegacyPgConnInput = {
      host: shadowInput.hostname,
      port: shadowInput.shadowPort,
      user: "postgres",
      password: shadowInput.password,
      database: "postgres",
    };
    yield* legacyWaitForShadowReady(spawner, handle.containerId, connConfig, {
      timeoutSeconds: shadowInput.healthTimeoutSeconds,
      image: shadowInput.image,
    });
    yield* legacySetupShadowDatabase(
      spawner,
      {
        fs,
        path,
        workdir: ctx.cwd,
        projectId: shadowInput.projectId,
        container: handle.containerId,
        networkId: shadowInput.networkId,
        connConfig,
        setup: shadowInput.setup,
      },
      {},
      handle,
    );
    return { sourceUrl: legacyToPostgresURL(connConfig) } satisfies LegacyProvisionedShadow;
  });

/**
 * {@link exportViaShadowCatalog}'s `provision` for {@link legacyExportDeclarativeCatalogRef}: the
 * platform baseline, THEN the declarative directory applied to the shadow's own `postgres`
 * database (NOT `contrib_regression` — unlike `legacy-shadow-source.ts`'s local-target override
 * branch, there is no separate "target" database here; the shadow IS the declarative target).
 * Mirrors Go's `getDeclarativeCatalogRef`/`writeDeclarativeCatalogFromConfig`
 * (`declarative.go:434-485`).
 */
const legacyProvisionDeclarativeShadow = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  declarativeDirAbs: string,
  declarativeDirRel: string,
  handle: LegacyShadowAcquiredHandle,
  shadowInput: LegacyShadowSetupInput<LegacyDbConfigLoadError>,
) =>
  Effect.gen(function* () {
    const connConfig: LegacyPgConnInput = {
      host: shadowInput.hostname,
      port: shadowInput.shadowPort,
      user: "postgres",
      password: shadowInput.password,
      database: "postgres",
    };
    yield* legacyWaitForShadowReady(spawner, handle.containerId, connConfig, {
      timeoutSeconds: shadowInput.healthTimeoutSeconds,
      image: shadowInput.image,
    });
    yield* legacySetupShadowDatabase(
      spawner,
      {
        fs,
        path,
        workdir: ctx.cwd,
        projectId: shadowInput.projectId,
        container: handle.containerId,
        networkId: shadowInput.networkId,
        connConfig,
        setup: shadowInput.setup,
      },
      {},
      handle,
    );
    const targetUrl = legacyToPostgresURL(connConfig);
    yield* legacyApplyDeclarativePgDelta(ctx, {
      fs,
      declarativeDirAbs,
      declarativeDirRel,
      target: targetUrl,
    });
    return { sourceUrl: targetUrl } satisfies LegacyProvisionedShadow;
  });

/**
 * Resolves (and caches under `supabase/.temp/pgdelta/`) the pg-delta BASELINE catalog — the
 * Supabase platform baseline (auth/storage/realtime) with no local migrations and no
 * declarative files applied. Backs `LegacyDeclarativeSeam.exportCatalog({ mode: "baseline" })` —
 * `db schema declarative generate`'s own diff SOURCE, and (via
 * {@link legacyGetMigrationsCatalogRef}'s own zero-migrations special case above) `sync`'s diff
 * source when there are no local migrations. Mirrors Go's `getGenerateBaselineCatalogRef`
 * (`apps/cli-go/internal/db/declarative/declarative.go:306-361`).
 *
 * Unlike Go, which can reuse ONE shadow across `Generate`'s own export and its post-write cache
 * warm (`generateBaselineCatalogRef.shadow`), this always provisions (and tears down) its own
 * shadow per call — see `legacy-pgdelta.seam.service.ts`'s own doc comment for why that
 * simplification is deliberate and accepted.
 */
export const legacyExportBaselineCatalogRef = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  cliProjectId: Option.Option<string>,
  params: { readonly noCache: boolean; readonly projectRef?: string },
) =>
  Effect.gen(function* () {
    const toml = yield* legacyReadDbToml(fs, path, workdir, params.projectRef);
    const ctx: LegacyPgDeltaContext = {
      projectId: legacyResolvePgDeltaProjectId(cliProjectId, toml, workdir),
      cwd: workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
      projectEnv: toml.projectEnv,
    };
    const tempDir = legacyPgDeltaTempPath(path, workdir);
    const setupInputs = yield* legacyResolveSetupInputs(
      fs,
      path,
      workdir,
      toml.majorVersion,
      Option.getOrUndefined(toml.orioledbVersion),
      toml.baseline,
    );
    // Built BEFORE the cache probe below, not just before the banner: this is the SECOND
    // `@supabase/config` load, and the Go `__catalog` child ran its equivalent in the command
    // pre-run unconditionally — so an invalid project (e.g. an unreadable `[api.tls]` cert)
    // failed consistently whether or not a cached catalog existed. Probing first would make
    // that failure appear and disappear with cache state.
    const built = yield* legacyBuildShadowCatalogInputs(ctx, toml, params);
    const cachePath = path.join(
      tempDir,
      legacyBaselineCatalogFileName(legacyBaselineCatalogKey(setupInputs)),
    );
    if (!params.noCache) {
      // Same propagation as the zero-migrations probe in `legacyResolveMigrationsCatalogRef`:
      // `fs.exists` maps only not-found to `false`, so a failing probe (permissions, I/O)
      // fails the export before any Docker side effect instead of faking a cache miss.
      const exists = yield* fs.exists(cachePath);
      if (exists) return path.relative(workdir, cachePath);
    }

    const output = yield* Output;
    yield* output.raw("Creating shadow database...\n", "stderr");
    return yield* exportViaShadowCatalog(
      fs,
      path,
      ctx,
      toml,
      built,
      (spawner, handle, shadowInput) =>
        legacyProvisionBaselineShadow(spawner, fs, path, ctx, handle, shadowInput),
      (snapshot) =>
        params.noCache
          ? legacyWriteCatalogFile(
              fs,
              tempDir,
              path.join(tempDir, LEGACY_NO_CACHE_BASELINE_CATALOG_NAME),
              snapshot,
            )
          : legacyWriteCatalogFile(fs, tempDir, cachePath, snapshot),
      { bypassCache: params.noCache, webhooks: "config" },
    );
  });

/**
 * Resolves (and caches under `supabase/.temp/pgdelta/`) the pg-delta DECLARATIVE catalog — the
 * Supabase platform baseline with the declarative directory applied. Backs
 * `LegacyDeclarativeSeam.exportCatalog({ mode: "declarative" })` — `sync`'s diff TARGET, and the
 * cache `generate` warms after writing declarative files. Mirrors Go's `getDeclarativeCatalogRef`
 * (`apps/cli-go/internal/db/declarative/declarative.go:434-461`).
 */
export const legacyExportDeclarativeCatalogRef = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  cliProjectId: Option.Option<string>,
  params: { readonly noCache: boolean; readonly projectRef?: string },
) =>
  Effect.gen(function* () {
    const toml = yield* legacyReadDbToml(fs, path, workdir, params.projectRef);
    const ctx: LegacyPgDeltaContext = {
      projectId: legacyResolvePgDeltaProjectId(cliProjectId, toml, workdir),
      cwd: workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
      projectEnv: toml.projectEnv,
    };
    const tempDir = legacyPgDeltaTempPath(path, workdir);
    const declarativeDirRel = legacyResolveDeclarativeDir(path, toml.pgDelta);
    const declarativeDirAbs = path.resolve(workdir, declarativeDirRel);

    const setupInputs = yield* legacyResolveSetupInputs(
      fs,
      path,
      workdir,
      toml.majorVersion,
      Option.getOrUndefined(toml.orioledbVersion),
      toml.baseline,
    );
    const setupToken = legacySetupInputsToken(setupInputs);
    const schemaHash = yield* legacyHashDeclarativeSchemas(fs, path, declarativeDirAbs);
    const hash = legacyDeclarativeCatalogCacheKey(setupToken, schemaHash);
    const prefix = "local";

    // Built BEFORE the cache probe — see `legacyExportBaselineCatalogRef`'s own comment above:
    // config validation must not depend on cache state.
    const built = yield* legacyBuildShadowCatalogInputs(ctx, toml, params);
    if (!params.noCache) {
      const cached = yield* legacyResolveDeclarativeCatalogPath(fs, path, tempDir, hash, prefix);
      if (Option.isSome(cached)) return path.relative(workdir, cached.value);
    }

    const output = yield* Output;
    yield* output.raw("Creating shadow database...\n", "stderr");
    return yield* exportViaShadowCatalog(
      fs,
      path,
      ctx,
      toml,
      built,
      (spawner, handle, shadowInput) =>
        legacyProvisionDeclarativeShadow(
          spawner,
          fs,
          path,
          ctx,
          declarativeDirAbs,
          declarativeDirRel,
          handle,
          shadowInput,
        ),
      (snapshot) =>
        params.noCache
          ? legacyWriteCatalogFile(
              fs,
              tempDir,
              path.join(tempDir, LEGACY_NO_CACHE_DECLARATIVE_CATALOG_NAME),
              snapshot,
            )
          : Effect.gen(function* () {
              const timestamp = yield* Clock.currentTimeMillis;
              return yield* legacyWriteDeclarativeCatalogSnapshot(
                fs,
                path,
                tempDir,
                prefix,
                hash,
                snapshot,
                timestamp,
              );
            }),
      { bypassCache: params.noCache, webhooks: "config" },
    );
  });
