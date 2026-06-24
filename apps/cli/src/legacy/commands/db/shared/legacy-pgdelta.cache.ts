import { createHash } from "node:crypto";
import { Effect, type FileSystem, Option, type Path } from "effect";

import { LegacyMigrationsReadError } from "./legacy-pgdelta.errors.ts";

/**
 * Declarative catalog-cache key builders + on-disk catalog resolution, ported
 * 1:1 from Go (`apps/cli-go/internal/db/declarative/declarative.go` +
 * `internal/db/pgcache/cache.go`). Byte-stable parity matters: caches under
 * `supabase/.temp/pgdelta/` are shared with the Go binary, so a drifting key
 * would silently miss (re-provision) or over-hit (reuse a stale snapshot).
 */

const CATALOG_PREFIX_PATTERN = /[^a-zA-Z0-9._-]+/g;
const CATALOG_RETENTION_COUNT = 2;
// `pkg/migration/list.go` — `<14-digit>_init.sql` first migrations (pre-2021-12-09) are skipped.
const INIT_SCHEMA_PATTERN = /([0-9]{14})_init\.sql/;
const INIT_SCHEMA_CUTOFF = 20211209000000;
// `pkg/migration/file.go` — valid migration filenames.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;

/** Inputs to `setupInputsToken` — everything `start.SetupDatabase` consumes. */
export interface LegacySetupInputs {
  /** The resolved Postgres image (`Config.Db.Image`); only its tag is used. */
  readonly image: string;
  readonly majorVersion: number;
  readonly authEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly realtimeEnabled: boolean;
  /** Effective `api.auto_expose_new_tables` (unset and false both → false). */
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

/** Mirrors Go's `declarativeCatalogCacheKey` (`declarative.go:753`): `<setupToken>-<schemaHash>`. */
export function legacyDeclarativeCatalogCacheKey(setupToken: string, schemaHash: string): string {
  return `${setupToken}-${schemaHash}`;
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

/** `supabase/.temp/pgdelta` — where catalog snapshots + debug bundles live. */
export function legacyPgDeltaTempPath(path: Path.Path, workdir: string): string {
  return path.join(workdir, "supabase", ".temp", "pgdelta");
}

/**
 * Lists local migration file paths under `migrationsDir`. Mirrors Go's
 * `migration.ListLocalMigrations` (`pkg/migration/list.go:33`): entries are
 * sorted by name, directories skipped, a deprecated `<14-digit>_init.sql` first
 * migration (pre-2021-12-09) is skipped, and names must match `<digits>_*.sql`.
 */
export const legacyListLocalMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
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
  const sorted = [...names].sort();
  const result: Array<string> = [];
  for (let index = 0; index < sorted.length; index++) {
    const name = sorted[index]!;
    const stat = yield* fs.stat(path.join(migrationsDir, name)).pipe(Effect.option);
    if (Option.isSome(stat) && stat.value.type === "Directory") continue;
    if (index === 0) {
      const init = INIT_SCHEMA_PATTERN.exec(name);
      if (init !== null && Number(init[1]) < INIT_SCHEMA_CUTOFF) continue;
    }
    if (!MIGRATE_FILE_PATTERN.test(name)) continue;
    result.push(path.join(migrationsDir, name));
  }
  return result as ReadonlyArray<string>;
});

/**
 * Mirrors Go's `pgcache.HashMigrations` (`pgcache/cache.go`): for each local
 * migration (in list order), hash its path then its contents. Returns full hex.
 */
export const legacyHashMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  const hash = createHash("sha256");
  for (const filePath of migrations) {
    const contents = yield* fs.readFile(filePath);
    hash.update(filePath, "utf8");
    hash.update(contents);
  }
  return hash.digest("hex");
});

const collectSqlFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return [] as ReadonlyArray<string>;
  const files: Array<string> = [];
  const stack: Array<string> = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = yield* fs.stat(full).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      if (stat.value.type === "Directory") stack.push(full);
      else if (path.extname(name) === ".sql") files.push(full);
    }
  }
  return files as ReadonlyArray<string>;
});

/**
 * Mirrors Go's `hashDeclarativeSchemas` (`declarative.go:515`): walk the
 * declarative dir for `.sql` files, sort by path, and hash each file's
 * forward-slash relative path then its contents. Returns full hex.
 */
export const legacyHashDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
) {
  const files = [...(yield* collectSqlFiles(fs, path, declarativeDir))].sort();
  const hash = createHash("sha256");
  for (const filePath of files) {
    const contents = yield* fs.readFile(filePath);
    const rel = path.relative(declarativeDir, filePath).split("\\").join("/");
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

const listJsonEntries = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, tempDir: string) {
  const exists = yield* fs.exists(tempDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return [] as ReadonlyArray<string>;
  return yield* fs
    .readDirectory(tempDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
});

/**
 * Resolves the newest cached declarative catalog for `(prefix, hash)`. Mirrors
 * Go's `resolveDeclarativeCatalogPath` (`declarative.go:578`): of all
 * `catalog-<prefix>-declarative-<hash>-<ts>.json`, returns the highest `ts`.
 */
export const legacyResolveDeclarativeCatalogPath = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
  hash: string,
) {
  const entries = yield* listJsonEntries(fs, tempDir);
  const familyPrefix = `catalog-${legacySanitizedCatalogPrefix(prefix)}-declarative-${hash}-`;
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
 * Removes all but the newest `catalogRetentionCount` declarative catalogs for a
 * prefix family. Mirrors Go's `cleanupOldDeclarativeCatalogs` (`declarative.go:610`).
 */
export const legacyCleanupOldDeclarativeCatalogs = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempDir: string,
  prefix: string,
) {
  const entries = yield* listJsonEntries(fs, tempDir);
  const familyPrefix = `catalog-${legacySanitizedCatalogPrefix(prefix)}-declarative-`;
  const files = entries
    .filter((name) => name.startsWith(familyPrefix) && name.endsWith(".json"))
    .map((name) => ({ name, timestamp: Option.getOrElse(parseCatalogTimestamp(name), () => 0) }))
    .sort((a, b) =>
      b.timestamp === a.timestamp ? (a.name > b.name ? -1 : 1) : b.timestamp - a.timestamp,
    );
  for (let index = CATALOG_RETENTION_COUNT; index < files.length; index++) {
    yield* fs
      .remove(path.join(tempDir, files[index]!.name))
      .pipe(Effect.orElseSucceed(() => undefined));
  }
});
