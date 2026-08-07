import { createHash } from "node:crypto";
import { Clock, Effect, type FileSystem, Option, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyBaselineTomlConfig } from "./legacy-db-config.toml-read.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";
import { LegacyMigrationsReadError } from "./legacy-migration.errors.ts";
import { type LegacyPgDeltaContext, legacyExportCatalogPgDelta } from "./legacy-pgdelta.ts";
import { LegacyDeclarativeSeam } from "../commands/db/shared/legacy-pgdelta.seam.service.ts";

/**
 * Declarative catalog-cache key builders + on-disk catalog resolution, ported
 * 1:1 from Go (`apps/cli-go/internal/db/declarative/declarative.go` +
 * `internal/db/pgcache/cache.go`). Byte-stable parity matters: caches under
 * `supabase/.temp/pgdelta/` are shared with the Go binary, so a drifting key
 * would silently miss (re-provision) or over-hit (reuse a stale snapshot).
 *
 * Beyond the pure key/path builders, this file also owns the migrations-catalog
 * RESOLUTION path for both `db diff --from/--to migrations` and `db schema
 * declarative sync` ({@link legacyResolveMigrationsCatalogRef},
 * {@link legacyGetMigrationsCatalogRef}) — including shadow-database provisioning/
 * removal via `LegacyDeclarativeSeam` (Docker orchestration, unchanged from the Go
 * seam) and the "Creating shadow database..." stderr side effect the latter prints
 * on a cache miss. It is not a pure module.
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

/** Inputs to `setupInputsToken` — everything `start.SetupDatabase` consumes. */
export interface LegacySetupInputs {
  /** The resolved Postgres image (`Config.Db.Image`); only its tag is used. */
  readonly image: string;
  readonly majorVersion: number;
  readonly authEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly realtimeEnabled: boolean;
  /** Effective `experimental.webhooks.enabled` (absent → false). */
  readonly webhooksEnabled: boolean;
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
  payload += `database_webhooks=${boolToken(inputs.webhooksEnabled)}\n`;
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
  const image = yield* legacyResolveDbImage(fs, path, workdir, majorVersion, orioledbVersion);
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
    webhooksEnabled: baseline.webhooksEnabled,
    autoExpose:
      Option.isSome(baseline.apiAutoExposeNewTables) && baseline.apiAutoExposeNewTables.value,
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

/** `supabase/.temp/pgdelta` — where catalog snapshots + debug bundles live. */
export function legacyPgDeltaTempPath(path: Path.Path, workdir: string): string {
  return path.join(workdir, "supabase", ".temp", "pgdelta");
}

/**
 * Lists local migration file paths under `migrationsDir`. Mirrors Go's
 * `migration.ListLocalMigrations` (`pkg/migration/list.go:33`): entries are
 * sorted by name, directories skipped, a deprecated `<14-digit>_init.sql` first
 * migration (pre-2021-12-09) is skipped, and names must match `<digits>_*.sql`.
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
  const sorted = [...names].sort();
  const result: Array<string> = [];
  for (let index = 0; index < sorted.length; index++) {
    const name = sorted[index]!;
    const stat = yield* fs.stat(path.join(migrationsDir, name)).pipe(Effect.option);
    if (Option.isSome(stat) && stat.value.type === "Directory") continue;
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
    result.push(path.join(migrationsDir, name));
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
  for (let index = CATALOG_RETENTION_COUNT; index < files.length; index++) {
    yield* fs
      .remove(path.join(tempDir, files[index]!.name))
      .pipe(Effect.orElseSucceed(() => undefined));
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
    readonly nowMillis: number;
  },
) {
  if (!params.enabled) return;
  const prefix = legacyCatalogPrefixFromConfig(params.conn, params.isLocal);
  const hash = yield* legacyHashMigrations(fs, path, ctx.cwd, params.migrationsDir);
  const snapshot = yield* legacyExportCatalogPgDelta(ctx, {
    targetRef: params.targetUrl,
    role: "postgres",
  });
  yield* legacyWriteMigrationCatalogSnapshot(
    fs,
    path,
    legacyPgDeltaTempPath(path, ctx.cwd),
    prefix,
    hash,
    snapshot,
    params.nowMillis,
  );
});

/**
 * Shared shadow-provision → pg-delta export → persist → cleanup mechanics behind
 * both {@link legacyResolveMigrationsCatalogRef} and {@link legacyGetMigrationsCatalogRef}
 * on a cache miss: provisions the shadow via the EXISTING
 * `LegacyDeclarativeSeam.provisionShadow` (Go's `db __shadow --mode diff`, unchanged
 * / out of scope for CLI-1959 — `CreateShadowDatabase` + `MigrateShadowDatabase` are
 * the exact same Go primitives both callers' Go counterparts call directly,
 * `internal/db/diff/shadow.go:37-53` with `targetLocal=false` skipping its only
 * extra branch), exports its catalog via the already-native
 * {@link legacyExportCatalogPgDelta} (the same edge-runtime script Go's own
 * `ExportCatalogPgDelta` runs), hands the snapshot to `persist` to decide where it
 * lands on disk, then ALWAYS removes the shadow container (`Effect.ensuring`,
 * success or failure) before returning. The persisted path is made relative to
 * `ctx.cwd` before returning: every caller feeds this ref into pg-delta's
 * edge-runtime scripts as SOURCE/TARGET, which prefix a bare (non-postgres://) ref
 * with `/workspace/` — matching the container bind `${ctx.cwd}:/workspace`
 * (`legacyPgDeltaContainerRef`, `legacy-pgdelta.ts:100-103`). Go's equivalent
 * (`pgcache.WriteMigrationCatalogSnapshot`) is only ever built from `utils.TempDir`,
 * a workdir-RELATIVE constant (Go chdirs into the workdir first), so the ref it
 * returns is relative too; return the same shape here rather than the absolute host
 * path `persist` builds internally. The two public functions differ only in their
 * cache-decision and `persist`'s cache-write logic, not in this mechanics.
 */
const exportViaShadowCatalog = <E, R>(
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  provisionParams: { readonly projectRef?: string },
  persist: (snapshot: string) => Effect.Effect<string, E, R>,
) =>
  Effect.gen(function* () {
    const seam = yield* LegacyDeclarativeSeam;
    const shadow = yield* seam.provisionShadow({
      mode: "diff",
      schema: [],
      ...(provisionParams.projectRef !== undefined
        ? { projectRef: provisionParams.projectRef }
        : {}),
    });
    const written = yield* Effect.gen(function* () {
      const snapshot = yield* legacyExportCatalogPgDelta(ctx, {
        targetRef: shadow.sourceUrl,
        role: "postgres",
      });
      return yield* persist(snapshot);
    }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));
    return path.relative(ctx.cwd, written);
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
 * {@link legacyWriteMigrationCatalogSnapshot}.
 */
export const legacyResolveMigrationsCatalogRef = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  params: { readonly projectRef?: string },
) {
  const tempDir = legacyPgDeltaTempPath(path, ctx.cwd);
  const migrationsDir = path.join(ctx.cwd, "supabase", "migrations");
  const hash = yield* legacyHashMigrations(fs, path, ctx.cwd, migrationsDir);
  const cached = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, hash, "local");
  if (Option.isSome(cached)) return path.relative(ctx.cwd, cached.value);

  return yield* exportViaShadowCatalog(path, ctx, params, (snapshot) =>
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
 * {@link exportViaShadowCatalog} — see its doc comment.
 */
export const legacyGetMigrationsCatalogRef = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  ctx: LegacyPgDeltaContext,
  setupInputs: LegacySetupInputs,
  params: { readonly noCache: boolean; readonly projectRef?: string },
) {
  const output = yield* Output;
  const tempDir = legacyPgDeltaTempPath(path, ctx.cwd);
  const migrationsDir = path.join(ctx.cwd, "supabase", "migrations");
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  const zeroMigrations = migrations.length === 0;

  const baselinePath = path.join(
    tempDir,
    legacyBaselineCatalogFileName(legacyBaselineCatalogKey(setupInputs)),
  );
  if (zeroMigrations && !params.noCache) {
    const exists = yield* fs.exists(baselinePath).pipe(Effect.orElseSucceed(() => false));
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
  return yield* exportViaShadowCatalog(path, ctx, params, (snapshot) =>
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
  );
});
