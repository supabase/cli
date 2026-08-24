import { createHash } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { LegacyEdgeRuntimeScript } from "./legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "./legacy-pgdelta-ssl-probe.service.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";
import { type LegacyPgDeltaContext } from "./legacy-pgdelta.ts";
import {
  LEGACY_NO_CACHE_BASELINE_CATALOG_NAME,
  LEGACY_NO_CACHE_DECLARATIVE_CATALOG_NAME,
  type LegacySetupInputs,
  legacyBaselineCatalogFileName,
  legacyBaselineCatalogKey,
  legacyBaselineVersionToken,
  legacyCatalogPrefixFromConfig,
  legacyCleanupOldDeclarativeCatalogs,
  legacyCleanupOldMigrationCatalogs,
  legacyDeclarativeCatalogCacheKey,
  legacyDeclarativeCatalogFileName,
  legacyHashDeclarativeSchemas,
  legacyHashMigrations,
  legacyListLocalMigrations,
  legacyMigrationCatalogFileName,
  legacyMigrationsCatalogCacheKey,
  legacyResolveDeclarativeCatalogPath,
  legacyResolveMigrationCatalogPath,
  legacyResolveSetupInputs,
  legacySanitizedCatalogPrefix,
  legacySetupInputsToken,
  legacyTryCacheMigrationsCatalog,
  legacyWriteDeclarativeCatalogSnapshot,
  legacyWriteMigrationCatalogSnapshot,
} from "./legacy-pgdelta.cache.ts";

const BASE: LegacySetupInputs = {
  image: "supabase/postgres:17.6.1.135",
  majorVersion: 17,
  authEnabled: true,
  storageEnabled: true,
  realtimeEnabled: true,
  autoExpose: false,
  vaultNames: [],
  rolesSql: "",
};

const sha12 = (payload: string) =>
  createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);

describe("legacySanitizedCatalogPrefix", () => {
  it("defaults blank to 'local' and sanitizes non [a-zA-Z0-9._-]", () => {
    expect(legacySanitizedCatalogPrefix("  ")).toBe("local");
    expect(legacySanitizedCatalogPrefix("local")).toBe("local");
    expect(legacySanitizedCatalogPrefix("db prod/2")).toBe("db-prod-2");
  });
});

describe("legacyBaselineVersionToken", () => {
  it("uses the image tag", () => {
    expect(legacyBaselineVersionToken("supabase/postgres:17.6.1.135", 17)).toBe("17.6.1.135");
  });

  it("falls back to pg<major> only when the image is empty", () => {
    expect(legacyBaselineVersionToken("", 15)).toBe("pg15");
    expect(legacyBaselineVersionToken("   ", 15)).toBe("pg15");
    // Go only slices when idx+1 < len, so a trailing-colon image is sanitized whole.
    expect(legacyBaselineVersionToken("supabase/postgres:", 14)).toBe("supabase-postgres-");
  });
});

describe("legacySetupInputsToken", () => {
  it("byte-matches the Go hash input sequence", () => {
    const expected = sha12(
      "17.6.1.135\nauth=true storage=true realtime=true\nauto_expose_new_tables=false\n",
    );
    expect(legacySetupInputsToken(BASE)).toBe(expected);
  });

  it("folds in sorted vault names and roles.sql", () => {
    const token = legacySetupInputsToken({
      ...BASE,
      vaultNames: ["b_secret", "a_secret"],
      rolesSql: "create role app;",
    });
    const expected = sha12(
      "17.6.1.135\nauth=true storage=true realtime=true\nauto_expose_new_tables=false\n" +
        "vault=a_secret\nvault=b_secret\ncreate role app;",
    );
    expect(token).toBe(expected);
  });

  it("self-invalidates when any baseline input changes", () => {
    const baseToken = legacySetupInputsToken(BASE);
    expect(legacySetupInputsToken({ ...BASE, authEnabled: false })).not.toBe(baseToken);
    expect(legacySetupInputsToken({ ...BASE, autoExpose: true })).not.toBe(baseToken);
    expect(legacySetupInputsToken({ ...BASE, vaultNames: ["x"] })).not.toBe(baseToken);
    expect(legacySetupInputsToken({ ...BASE, rolesSql: "x" })).not.toBe(baseToken);
    expect(legacySetupInputsToken({ ...BASE, image: "supabase/postgres:15.8.1.085" })).not.toBe(
      baseToken,
    );
  });
});

describe("catalog keys + file names", () => {
  it("composes the baseline + declarative cache keys", () => {
    expect(legacyBaselineCatalogKey(BASE)).toBe(`17.6.1.135-${legacySetupInputsToken(BASE)}`);
    expect(legacyDeclarativeCatalogCacheKey("setup12chars", "schemahash")).toBe(
      "setup12chars-schemahash",
    );
  });

  it("composes the migrations cache key used by `db schema declarative sync` (setup-token-folded)", () => {
    // Mirrors Go's `migrationsCatalogCacheKey` (`declarative.go:765`) — deliberately
    // different from `db diff`'s bare `pgcache.HashMigrations` key (CLI-1959): this
    // one folds the setup-inputs token in so a baseline/config change self-
    // invalidates the sync migrations catalog too.
    expect(legacyMigrationsCatalogCacheKey("setup12chars", "migrationshash")).toBe(
      "setup12chars-migrationshash",
    );
  });

  it("formats catalog file names", () => {
    expect(legacyBaselineCatalogFileName("17.6.1.135-abc")).toBe(
      "catalog-baseline-17.6.1.135-abc.json",
    );
    expect(legacyDeclarativeCatalogFileName("local", "h", 1700)).toBe(
      "catalog-local-declarative-h-1700.json",
    );
  });
});

const tempRoot = useLegacyTempWorkdir("legacy-decl-cache-");

const writeFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  relativePath: string,
  content: string,
) => {
  const fullPath = path.join(workdir, relativePath);
  return fs
    .makeDirectory(path.dirname(fullPath), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(fullPath, content)));
};

const run = <A, E extends Error>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Output>,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)));

const withServices = <A, E extends Error>(
  body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, Output>,
) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* body(fs, path);
    }),
  );

describe("legacyListLocalMigrations", () => {
  it.effect("returns sorted valid migrations, skipping a deprecated _init.sql first file", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const migrationsDir = path.join(dir, "supabase", "migrations");
        yield* writeFile(
          fs,
          path,
          dir,
          "supabase/migrations/20200101000000_init.sql",
          "-- old init",
        );
        yield* writeFile(
          fs,
          path,
          dir,
          "supabase/migrations/20240101120000_create.sql",
          "create table x();",
        );
        yield* writeFile(fs, path, dir, "supabase/migrations/notes.txt", "ignore me");
        const paths = yield* legacyListLocalMigrations(fs, path, migrationsDir);
        expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
      }),
    );
  });

  it.effect(
    "warns (byte-exact, on stderr) when skipping a deprecated init and a misnamed file",
    () => {
      // Mirrors Go's `ListLocalMigrations` warnings (`pkg/migration/list.go:45-53`):
      // a `fmt.Fprintf(os.Stderr, …)` for the deprecated `_init.sql` first file and
      // for any name that does not match `<timestamp>_name.sql`.
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const migrationsDir = path.join(dir, "supabase", "migrations");
        yield* writeFile(
          fs,
          path,
          dir,
          "supabase/migrations/20200101000000_init.sql",
          "-- old init",
        );
        yield* writeFile(
          fs,
          path,
          dir,
          "supabase/migrations/20240101120000_create.sql",
          "create table x();",
        );
        yield* writeFile(fs, path, dir, "supabase/migrations/notes.txt", "ignore me");
        const paths = yield* legacyListLocalMigrations(fs, path, migrationsDir);
        expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
        const stderr = out.rawChunks.filter((c) => c.stream === "stderr").map((c) => c.text);
        expect(stderr).toContain(
          'Skipping migration 20200101000000_init.sql... (replace "init" with a different file name to apply this migration)\n',
        );
        expect(stderr).toContain(
          'Skipping migration notes.txt... (file name must match pattern "<timestamp>_name.sql")\n',
        );
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)));
    },
  );

  it.effect(
    "includes a validly-named .sql symlink to a directory, matching Go's IsDir() (no follow)",
    () => {
      // Go's `os.ReadDir`/`DirEntry.IsDir()` (`pkg/migration/list.go:34-43`) classifies a
      // directory entry from its own type without following symlinks, so a `.sql` symlink
      // whose target is a directory is NOT skipped as a directory — it is only ever dropped
      // later, if something actually tries to read it as a file. A naive `fs.stat`-based
      // directory check (which follows symlinks) would misclassify it and silently skip it.
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const migrationsDir = path.join(dir, "supabase", "migrations");
          const targetDir = path.join(dir, "outside-target");
          yield* fs.makeDirectory(targetDir, { recursive: true });
          yield* writeFile(
            fs,
            path,
            dir,
            "supabase/migrations/20240101120000_create.sql",
            "create table x();",
          );
          yield* fs.symlink(targetDir, path.join(migrationsDir, "20240102000000_link.sql"));
          const paths = yield* legacyListLocalMigrations(fs, path, migrationsDir);
          expect(paths.map((p) => p.split("/").pop())).toEqual([
            "20240101120000_create.sql",
            "20240102000000_link.sql",
          ]);
        }),
      );
    },
  );

  it.effect(
    "sorts by UTF-8 byte order, matching Go's fs.ReadDir, not JS's default UTF-16 code-unit order",
    () => {
      // Go's `fs.ReadDir` (`pkg/migration/list.go:34`) sorts entries byte-wise over each name's
      // UTF-8 encoding. A BMP private-use character (U+E000, single UTF-16 code unit `0xE000`)
      // and a supplementary-plane character (U+1F600, a surrogate pair starting `0xD83D`) reverse
      // order between the two schemes: JS's default `Array.prototype.sort()` ranks the surrogate
      // pair first (`0xD83D < 0xE000`), while Go's byte order — which preserves codepoint order —
      // ranks U+1F600 (`> U+FFFF`) after U+E000. A migrations directory with such filenames must
      // replay in Go's order, not JS's default, or a dependent migration could apply out of order.
      const privateUseFile = "20240101120000_z\uE000.sql";
      const supplementaryFile = "20240101120000_z\u{1F600}.sql";
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const migrationsDir = path.join(dir, "supabase", "migrations");
          yield* writeFile(
            fs,
            path,
            dir,
            `supabase/migrations/${privateUseFile}`,
            "create table x();",
          );
          yield* writeFile(
            fs,
            path,
            dir,
            `supabase/migrations/${supplementaryFile}`,
            "create table y();",
          );
          const paths = yield* legacyListLocalMigrations(fs, path, migrationsDir);
          expect(paths.map((p) => p.split("/").pop())).toEqual([privateUseFile, supplementaryFile]);
        }),
      );
    },
  );

  it.effect("returns [] when the migrations dir is absent", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const paths = yield* legacyListLocalMigrations(
          fs,
          path,
          path.join(tempRoot.current, "nope"),
        );
        expect(paths).toEqual([]);
      }),
    );
  });

  it.effect("fails (instead of returning []) when the migrations path is unreadable", () => {
    // `supabase/migrations` exists but is a file, not a directory — Go's
    // ListLocalMigrations aborts with `failed to read directory` rather than
    // treating it as "no migrations".
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const migrationsPath = path.join(dir, "supabase", "migrations");
        yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
        yield* fs.writeFileString(migrationsPath, "not a directory");
        const exit = yield* legacyListLocalMigrations(fs, path, migrationsPath).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});

describe("legacyHashMigrations", () => {
  it.effect(
    "hashes the workdir-relative path + contents in list order (stable, content-sensitive)",
    () => {
      const expected = createHash("sha256")
        .update("supabase/migrations/20240101120000_create.sql", "utf8")
        .update(Buffer.from("create table x();"))
        .digest("hex");
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const migrationsDir = path.join(dir, "supabase", "migrations");
          yield* writeFile(
            fs,
            path,
            dir,
            "supabase/migrations/20240101120000_create.sql",
            "create table x();",
          );
          const hash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
          expect(hash).toBe(expected);
        }),
      );
    },
  );

  it.effect(
    "is unaffected by the absolute location of workdir (Go-parity, not machine-specific)",
    () => {
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dirA = yield* fs.makeTempDirectory({ prefix: "legacy-pgdelta-cache-a-" });
          const dirB = yield* fs.makeTempDirectory({ prefix: "legacy-pgdelta-cache-b-" });
          const migrationsA = path.join(dirA, "supabase", "migrations");
          const migrationsB = path.join(dirB, "supabase", "migrations");
          yield* writeFile(
            fs,
            path,
            dirA,
            "supabase/migrations/20240101120000_create.sql",
            "create table x();",
          );
          yield* writeFile(
            fs,
            path,
            dirB,
            "supabase/migrations/20240101120000_create.sql",
            "create table x();",
          );
          const hashA = yield* legacyHashMigrations(fs, path, dirA, migrationsA);
          const hashB = yield* legacyHashMigrations(fs, path, dirB, migrationsB);
          expect(hashA).toBe(hashB);
          yield* fs.remove(dirA, { recursive: true, force: true });
          yield* fs.remove(dirB, { recursive: true, force: true });
        }),
      );
    },
  );
});

describe("legacyHashDeclarativeSchemas", () => {
  it.effect("hashes forward-slash rel path + contents over sorted .sql files", () => {
    const expected = createHash("sha256")
      .update("nested/auth.sql", "utf8")
      .update(Buffer.from("B"))
      .update("public.sql", "utf8")
      .update(Buffer.from("A"))
      .digest("hex");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const declDir = path.join(dir, "supabase", "database");
        yield* writeFile(fs, path, dir, "supabase/database/public.sql", "A");
        yield* writeFile(fs, path, dir, "supabase/database/nested/auth.sql", "B");
        yield* writeFile(fs, path, dir, "supabase/database/skip.txt", "C");
        const hash = yield* legacyHashDeclarativeSchemas(fs, path, declDir);
        expect(hash).toBe(expected);
      }),
    );
  });

  // A directory symlink pointing at an ancestor must not loop the walk, and symlinked
  // entries are excluded from the hash entirely — matching the walker's no-follow
  // semantics (codex review, PR #6162).
  it.effect("skips symlinked entries instead of following them", () => {
    const expected = createHash("sha256")
      .update("public.sql", "utf8")
      .update(Buffer.from("A"))
      .digest("hex");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const declDir = path.join(dir, "supabase", "database");
        yield* writeFile(fs, path, dir, "supabase/database/public.sql", "A");
        yield* fs.symlink(path.join(dir, "supabase"), path.join(declDir, "loop"));
        const hash = yield* legacyHashDeclarativeSchemas(fs, path, declDir);
        expect(hash).toBe(expected);
      }),
    );
  });

  // Retention removal failures must propagate — a silently-failing cleanup would let
  // snapshots accumulate forever while every run reports success (codex review, PR #6162).
  it.effect("cleanup fails when an old snapshot cannot be removed", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const tempDir = path.join(dir, "pgdelta");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        for (const ts of [100, 200, 300]) {
          yield* writeFile(fs, path, dir, `pgdelta/catalog-local-declarative-h-${ts}.json`, "{}");
        }
        const err = PlatformError.systemError({
          module: "FileSystem",
          method: "remove",
          _tag: "PermissionDenied",
          description: "permission denied",
          pathOrDescriptor: path.join(dir, "pgdelta"),
        });
        const failing: FileSystem.FileSystem = { ...fs, remove: () => Effect.fail(err) };
        const exit = yield* legacyCleanupOldDeclarativeCatalogs(
          failing,
          path,
          tempDir,
          "local",
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });

  // A root-level failure that isn't not-found (permissions, I/O) must propagate rather
  // than be treated as an empty tree — an empty-tree hash could cache an empty catalog
  // and let sync emit destructive drops (codex review, PR #6162).
  it.effect("fails when the root existence check itself fails", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const declDir = path.join(dir, "supabase", "database");
        yield* fs.makeDirectory(declDir, { recursive: true });
        const err = PlatformError.systemError({
          module: "FileSystem",
          method: "exists",
          _tag: "PermissionDenied",
          description: "permission denied",
          pathOrDescriptor: declDir,
        });
        const failing: FileSystem.FileSystem = { ...fs, exists: () => Effect.fail(err) };
        const exit = yield* legacyHashDeclarativeSchemas(failing, path, declDir).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });

  // A partial hash can collide with an existing cache key and serve a stale catalog,
  // so a traversal failure must fail the hash, not shrink it (codex review, PR #6162).
  it.effect("fails when part of the tree cannot be read instead of hashing a subset", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const declDir = path.join(dir, "supabase", "database");
        yield* writeFile(fs, path, dir, "supabase/database/public.sql", "A");
        yield* writeFile(fs, path, dir, "supabase/database/nested/auth.sql", "B");
        const failing: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p, opts) =>
            p.endsWith("nested")
              ? fs.readDirectory(path.join(dir, "does-not-exist"))
              : fs.readDirectory(p, opts),
        };
        const exit = yield* legacyHashDeclarativeSchemas(failing, path, declDir).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});

describe("legacyResolveDeclarativeCatalogPath + cleanup", () => {
  it.effect("resolves the newest snapshot and prunes to the retention count", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const tempDir = path.join(dir, "pgdelta");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        for (const ts of [100, 300, 200]) {
          yield* writeFile(fs, path, dir, `pgdelta/catalog-local-declarative-h-${ts}.json`, "{}");
        }
        yield* writeFile(fs, path, dir, "pgdelta/catalog-local-declarative-other-50.json", "{}");
        const latest = yield* legacyResolveDeclarativeCatalogPath(fs, path, tempDir, "h", "local");
        expect(Option.getOrNull(latest)?.endsWith("catalog-local-declarative-h-300.json")).toBe(
          true,
        );
        yield* legacyCleanupOldDeclarativeCatalogs(fs, path, tempDir, "local");
        const remaining = (yield* fs.readDirectory(tempDir)).filter((n) =>
          n.startsWith("catalog-local-declarative-"),
        );
        expect(remaining.sort()).toEqual([
          "catalog-local-declarative-h-200.json",
          "catalog-local-declarative-h-300.json",
        ]);
      }),
    );
  });
});

describe("no-cache catalog file names", () => {
  it("matches Go's noCacheBaselineCatalogPath/noCacheDeclarativeCatalogPath literals", () => {
    expect(LEGACY_NO_CACHE_BASELINE_CATALOG_NAME).toBe("catalog-nocache-baseline.json");
    expect(LEGACY_NO_CACHE_DECLARATIVE_CATALOG_NAME).toBe("catalog-nocache-declarative.json");
  });
});

describe("legacyWriteDeclarativeCatalogSnapshot + cleanup", () => {
  it.effect(
    "writes the snapshot and prunes older declarative catalogs past the retention count",
    () => {
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const tempDir = path.join(dir, "pgdelta");
          yield* fs.makeDirectory(tempDir, { recursive: true });
          for (const ts of [100, 300, 200]) {
            yield* writeFile(fs, path, dir, `pgdelta/catalog-local-declarative-h-${ts}.json`, "{}");
          }
          const filePath = yield* legacyWriteDeclarativeCatalogSnapshot(
            fs,
            path,
            tempDir,
            "local",
            "h",
            '{"snapshot":true}',
            400,
          );
          expect(filePath.endsWith("catalog-local-declarative-h-400.json")).toBe(true);
          expect(yield* fs.readFileString(filePath)).toBe('{"snapshot":true}');
          const remaining = (yield* fs.readDirectory(tempDir)).filter((n) =>
            n.startsWith("catalog-local-declarative-"),
          );
          expect(remaining.sort()).toEqual([
            "catalog-local-declarative-h-300.json",
            "catalog-local-declarative-h-400.json",
          ]);
        }),
      );
    },
  );

  it.effect("creates the temp dir when it doesn't exist yet", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const tempDir = path.join(tempRoot.current, "pgdelta");
        yield* legacyWriteDeclarativeCatalogSnapshot(fs, path, tempDir, "local", "h", "{}", 100);
        expect(yield* fs.exists(path.join(tempDir, "catalog-local-declarative-h-100.json"))).toBe(
          true,
        );
      }),
    );
  });
});

describe("legacyCatalogPrefixFromConfig", () => {
  const CONN = { host: "127.0.0.1", port: 5432, user: "postgres", database: "postgres" };

  it("returns 'local' for a local database regardless of host", () => {
    expect(legacyCatalogPrefixFromConfig(CONN, true)).toBe("local");
  });

  it("returns the project ref for a direct db.<ref>.supabase.{co,red} host", () => {
    const ref = "abcdefghijklmnopqrst";
    expect(legacyCatalogPrefixFromConfig({ ...CONN, host: `db.${ref}.supabase.co` }, false)).toBe(
      ref,
    );
    expect(legacyCatalogPrefixFromConfig({ ...CONN, host: `db.${ref}.supabase.red` }, false)).toBe(
      ref,
    );
  });

  it("falls back to a stable url-<sha256[:12]> hash for anything else", () => {
    const conn = {
      host: "aws-0-us-east-1.pooler.supabase.com",
      port: 6543,
      user: "postgres.ref",
      database: "postgres",
    };
    expect(legacyCatalogPrefixFromConfig(conn, false)).toBe(
      `url-${sha12(`${conn.user}@${conn.host}:${conn.port}/${conn.database}`)}`,
    );
  });

  it("does not match a host with the wrong ref length or a different TLD", () => {
    const conn = { ...CONN, host: "db.tooshort.supabase.co" };
    const digest = createHash("sha256")
      .update(`${conn.user}@${conn.host}:${conn.port}/${conn.database}`, "utf8")
      .digest("hex");
    expect(legacyCatalogPrefixFromConfig(conn, false)).toBe(`url-${digest.slice(0, 12)}`);
  });
});

describe("legacyResolveMigrationCatalogPath", () => {
  it.effect("resolves the newest snapshot for the (hash, prefix) family", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const tempDir = path.join(dir, "pgdelta");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        for (const ts of [100, 300, 200]) {
          yield* writeFile(fs, path, dir, `pgdelta/catalog-local-migrations-h-${ts}.json`, "{}");
        }
        // A different hash in the same prefix family must not be picked up.
        yield* writeFile(fs, path, dir, "pgdelta/catalog-local-migrations-other-500.json", "{}");
        const latest = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, "h", "local");
        expect(Option.getOrNull(latest)?.endsWith("catalog-local-migrations-h-300.json")).toBe(
          true,
        );
      }),
    );
  });

  it.effect("returns None on a cache miss (no matching family member)", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const resolved = yield* legacyResolveMigrationCatalogPath(
          fs,
          path,
          path.join(tempRoot.current, "pgdelta"),
          "h",
          "local",
        );
        expect(Option.isNone(resolved)).toBe(true);
      }),
    );
  });
});

describe("legacyResolveSetupInputs", () => {
  it.effect("resolves the image and tolerates a missing roles.sql", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const inputs = yield* legacyResolveSetupInputs(fs, path, tempRoot.current, 17, undefined, {
          authEnabled: true,
          storageEnabled: false,
          realtimeEnabled: true,
          apiAutoExposeNewTables: Option.none(),
          vaultNames: ["a_secret"],
        });
        expect(inputs).toMatchObject({
          majorVersion: 17,
          authEnabled: true,
          storageEnabled: false,
          realtimeEnabled: true,
          autoExpose: false,
          vaultNames: ["a_secret"],
          rolesSql: "",
        });
        expect(inputs.image.length).toBeGreaterThan(0);
      }),
    );
  });

  it.effect("reads roles.sql content and resolves the effective auto-expose bool", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        yield* writeFile(fs, path, dir, "supabase/roles.sql", "create role app;");
        const inputs = yield* legacyResolveSetupInputs(fs, path, dir, 17, undefined, {
          authEnabled: true,
          storageEnabled: true,
          realtimeEnabled: true,
          apiAutoExposeNewTables: Option.some(true),
          vaultNames: [],
        });
        expect(inputs.rolesSql).toBe("create role app;");
        expect(inputs.autoExpose).toBe(true);
      }),
    );
  });
});

describe("legacyMigrationCatalogFileName", () => {
  it("formats catalog-<prefix>-migrations-<hash>-<ts>.json", () => {
    expect(legacyMigrationCatalogFileName("local", "h", 1700)).toBe(
      "catalog-local-migrations-h-1700.json",
    );
  });
});

describe("legacyWriteMigrationCatalogSnapshot + cleanup", () => {
  it.effect(
    "writes the snapshot and prunes older migrations catalogs past the retention count",
    () => {
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const tempDir = path.join(dir, "pgdelta");
          yield* fs.makeDirectory(tempDir, { recursive: true });
          for (const ts of [100, 300, 200]) {
            yield* writeFile(fs, path, dir, `pgdelta/catalog-local-migrations-h-${ts}.json`, "{}");
          }
          const filePath = yield* legacyWriteMigrationCatalogSnapshot(
            fs,
            path,
            tempDir,
            "local",
            "h",
            '{"snapshot":true}',
            400,
          );
          expect(filePath.endsWith("catalog-local-migrations-h-400.json")).toBe(true);
          expect(yield* fs.readFileString(filePath)).toBe('{"snapshot":true}');
          const remaining = (yield* fs.readDirectory(tempDir)).filter((n) =>
            n.startsWith("catalog-local-migrations-"),
          );
          expect(remaining.sort()).toEqual([
            "catalog-local-migrations-h-300.json",
            "catalog-local-migrations-h-400.json",
          ]);
        }),
      );
    },
  );

  it.effect("creates the temp dir when it doesn't exist yet", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const tempDir = path.join(tempRoot.current, "pgdelta");
        yield* legacyWriteMigrationCatalogSnapshot(fs, path, tempDir, "local", "h", "{}", 100);
        expect(yield* fs.exists(path.join(tempDir, "catalog-local-migrations-h-100.json"))).toBe(
          true,
        );
      }),
    );
  });
});

describe("legacyTryCacheMigrationsCatalog — timestamp ordering (review CLI-1958)", () => {
  // `it.live` (not `it.effect`): the mocked export below uses a real `Effect.sleep`
  // to create a measurable time gap, which needs the real wall clock, not
  // `it.effect`'s virtual `TestClock` (which never auto-advances and would hang).
  it.live(
    "reads the clock AFTER the pg-delta export resolves, matching Go's WriteMigrationCatalogSnapshot ordering",
    () => {
      // Go's `TryCacheMigrationsCatalog` (`pgcache/cache.go:71-91`) resolves `hash`
      // and `snapshot` FIRST and only THEN calls `WriteMigrationCatalogSnapshot`,
      // which itself reads `time.Now().UTC()` (`pgcache/cache.go:151-163`) — i.e.
      // Go's clock read happens LAST, right before the file write. The mocked
      // edge-runtime export below sleeps for a real, measurable interval before
      // resolving; the written snapshot's embedded timestamp must reflect a moment
      // AFTER that sleep, proving the clock was read after the export — not
      // captured up front by a caller before this function even started (the
      // pre-fix bug).
      // Mirrors `legacyPgDeltaTempPath` (`<workdir>/supabase/.temp/pgdelta`).
      const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
        run: () =>
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis");
            return { stdout: "{}", stderr: "" };
          }),
      });
      const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
        requireSsl: () => Effect.succeed(false),
        requireSslForHost: () => Effect.succeed(false),
      });
      const ctx: LegacyPgDeltaContext = {
        projectId: "test",
        cwd: tempRoot.current,
        npmVersion: undefined,
        denoVersion: 1,
        projectEnv: {},
      };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const migrationsDir = path.join(dir, "supabase", "migrations");
        const tempDir = path.join(dir, "supabase", ".temp", "pgdelta");
        yield* fs.makeDirectory(migrationsDir, { recursive: true });
        const beforeCallMillis = yield* Clock.currentTimeMillis;
        yield* legacyTryCacheMigrationsCatalog(fs, path, ctx, {
          enabled: true,
          targetUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
          conn: { host: "127.0.0.1", port: 5432, user: "postgres", database: "postgres" },
          isLocal: true,
          migrationsDir,
        });
        const names = (yield* fs.readDirectory(tempDir)).filter((n) =>
          n.startsWith("catalog-local-migrations-"),
        );
        expect(names.length).toBe(1);
        const match = /-(\d+)\.json$/.exec(names[0]!);
        expect(match).not.toBeNull();
        const embeddedMillis = Number(match![1]);
        expect(embeddedMillis).toBeGreaterThanOrEqual(beforeCallMillis + 25);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            edge,
            sslProbe,
            makeLegacyViperEnvLayer(),
          ),
        ),
      );
    },
  );
});

describe("legacyCleanupOldMigrationCatalogs", () => {
  it.effect("only prunes files matching the given prefix's family", () => {
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const dir = tempRoot.current;
        const tempDir = path.join(dir, "pgdelta");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        for (const ts of [100, 200, 300]) {
          yield* writeFile(fs, path, dir, `pgdelta/catalog-local-migrations-h-${ts}.json`, "{}");
        }
        yield* writeFile(fs, path, dir, "pgdelta/catalog-other-migrations-h-50.json", "{}");
        yield* legacyCleanupOldMigrationCatalogs(fs, path, tempDir, "local");
        const remaining = (yield* fs.readDirectory(tempDir)).sort();
        expect(remaining).toEqual([
          "catalog-local-migrations-h-200.json",
          "catalog-local-migrations-h-300.json",
          "catalog-other-migrations-h-50.json",
        ]);
      }),
    );
  });

  it.effect(
    "propagates a permission-denied directory read instead of treating it as empty (Go ReadDir parity)",
    () => {
      // Go's CleanupOldMigrationCatalogs only tolerates a genuinely MISSING temp dir
      // (ensureTempDir already created it before ReadDir runs) — any other ReadDir
      // failure propagates, so a permission-denied listing must fail here too rather
      // than silently look like "no cached catalogs" (which would bypass retention
      // indefinitely, since the caller's own best-effort warning never fires without
      // a propagated failure).
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const dir = tempRoot.current;
          const tempDir = path.join(dir, "pgdelta");
          yield* writeFile(fs, path, dir, "pgdelta/catalog-local-migrations-h-100.json", "{}");
          yield* fs.chmod(tempDir, 0o000);
          const exit = yield* legacyCleanupOldMigrationCatalogs(fs, path, tempDir, "local").pipe(
            Effect.exit,
          );
          yield* fs.chmod(tempDir, 0o755);
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      );
    },
  );
});
