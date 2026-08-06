import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { LegacyEdgeRuntimeScript } from "./legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "./legacy-pgdelta-ssl-probe.service.ts";
import { type LegacyPgDeltaContext } from "./legacy-pgdelta.ts";
import {
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

const withTemp = () => mkdtempSync(join(tmpdir(), "legacy-decl-cache-"));

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | Output>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)),
  ) as Effect.Effect<A>;

const withServices = <A>(
  body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, unknown, Output>,
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
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20200101000000_init.sql"), "-- old init");
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    writeFileSync(join(migrationsDir, "notes.txt"), "ignore me");
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, migrationsDir)).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "warns (byte-exact, on stderr) when skipping a deprecated init and a misnamed file",
    () => {
      // Mirrors Go's `ListLocalMigrations` warnings (`pkg/migration/list.go:45-53`):
      // a `fmt.Fprintf(os.Stderr, …)` for the deprecated `_init.sql` first file and
      // for any name that does not match `<timestamp>_name.sql`.
      const dir = withTemp();
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20200101000000_init.sql"), "-- old init");
      writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
      writeFileSync(join(migrationsDir, "notes.txt"), "ignore me");
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* legacyListLocalMigrations(fs, path, migrationsDir);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)),
        Effect.tap((paths) =>
          Effect.sync(() => {
            expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
            const stderr = out.rawChunks.filter((c) => c.stream === "stderr").map((c) => c.text);
            expect(stderr).toContain(
              'Skipping migration 20200101000000_init.sql... (replace "init" with a different file name to apply this migration)\n',
            );
            expect(stderr).toContain(
              'Skipping migration notes.txt... (file name must match pattern "<timestamp>_name.sql")\n',
            );
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      ) as Effect.Effect<unknown>;
    },
  );

  it.effect("returns [] when the migrations dir is absent", () => {
    const dir = withTemp();
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, join(dir, "nope"))).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails (instead of returning []) when the migrations path is unreadable", () => {
    // `supabase/migrations` exists but is a file, not a directory — Go's
    // ListLocalMigrations aborts with `failed to read directory` rather than
    // treating it as "no migrations".
    const dir = withTemp();
    const migrationsPath = join(dir, "supabase", "migrations");
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(migrationsPath, "not a directory");
    return withServices((fs, path) =>
      legacyListLocalMigrations(fs, path, migrationsPath).pipe(Effect.exit),
    ).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(exit._tag).toBe("Failure");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyHashMigrations", () => {
  it.effect(
    "hashes the workdir-relative path + contents in list order (stable, content-sensitive)",
    () => {
      const dir = withTemp();
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      const file = join(migrationsDir, "20240101120000_create.sql");
      writeFileSync(file, "create table x();");
      const relPath = join("supabase", "migrations", "20240101120000_create.sql");
      const expected = createHash("sha256")
        .update(relPath, "utf8")
        .update(Buffer.from("create table x();"))
        .digest("hex");
      return withServices((fs, path) => legacyHashMigrations(fs, path, dir, migrationsDir)).pipe(
        Effect.tap((hash) =>
          Effect.sync(() => {
            expect(hash).toBe(expected);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "is unaffected by the absolute location of workdir (Go-parity, not machine-specific)",
    () => {
      const dirA = withTemp();
      const dirB = withTemp();
      const migrationsA = join(dirA, "supabase", "migrations");
      const migrationsB = join(dirB, "supabase", "migrations");
      mkdirSync(migrationsA, { recursive: true });
      mkdirSync(migrationsB, { recursive: true });
      writeFileSync(join(migrationsA, "20240101120000_create.sql"), "create table x();");
      writeFileSync(join(migrationsB, "20240101120000_create.sql"), "create table x();");
      return withServices((fs, path) =>
        Effect.gen(function* () {
          const hashA = yield* legacyHashMigrations(fs, path, dirA, migrationsA);
          const hashB = yield* legacyHashMigrations(fs, path, dirB, migrationsB);
          expect(hashA).toBe(hashB);
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            rmSync(dirA, { recursive: true, force: true });
            rmSync(dirB, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

describe("legacyHashDeclarativeSchemas", () => {
  it.effect("hashes forward-slash rel path + contents over sorted .sql files", () => {
    const dir = withTemp();
    const declDir = join(dir, "supabase", "database");
    mkdirSync(join(declDir, "nested"), { recursive: true });
    writeFileSync(join(declDir, "public.sql"), "A");
    writeFileSync(join(declDir, "nested", "auth.sql"), "B");
    writeFileSync(join(declDir, "skip.txt"), "C");
    const expected = createHash("sha256")
      .update("nested/auth.sql", "utf8")
      .update(Buffer.from("B"))
      .update("public.sql", "utf8")
      .update(Buffer.from("A"))
      .digest("hex");
    return withServices((fs, path) => legacyHashDeclarativeSchemas(fs, path, declDir)).pipe(
      Effect.tap((hash) =>
        Effect.sync(() => {
          expect(hash).toBe(expected);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyResolveDeclarativeCatalogPath + cleanup", () => {
  it.effect("resolves the newest snapshot and prunes to the retention count", () => {
    const dir = withTemp();
    const tempDir = join(dir, "pgdelta");
    mkdirSync(tempDir, { recursive: true });
    for (const ts of [100, 300, 200]) {
      writeFileSync(join(tempDir, `catalog-local-declarative-h-${ts}.json`), "{}");
    }
    writeFileSync(join(tempDir, "catalog-local-declarative-other-50.json"), "{}");
    return withServices((fs, path) =>
      Effect.gen(function* () {
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
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
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
    const dir = withTemp();
    const tempDir = join(dir, "pgdelta");
    mkdirSync(tempDir, { recursive: true });
    for (const ts of [100, 300, 200]) {
      writeFileSync(join(tempDir, `catalog-local-migrations-h-${ts}.json`), "{}");
    }
    // A different hash in the same prefix family must not be picked up.
    writeFileSync(join(tempDir, "catalog-local-migrations-other-500.json"), "{}");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const latest = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, "h", "local");
        expect(Option.getOrNull(latest)?.endsWith("catalog-local-migrations-h-300.json")).toBe(
          true,
        );
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
  });

  it.effect("returns None on a cache miss (no matching family member)", () => {
    const dir = withTemp();
    const tempDir = join(dir, "pgdelta");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        const resolved = yield* legacyResolveMigrationCatalogPath(fs, path, tempDir, "h", "local");
        expect(Option.isNone(resolved)).toBe(true);
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
  });
});

describe("legacyResolveSetupInputs", () => {
  it.effect("resolves the image and tolerates a missing roles.sql", () => {
    const dir = withTemp();
    return withServices((fs, path) =>
      legacyResolveSetupInputs(fs, path, dir, 17, undefined, {
        authEnabled: true,
        storageEnabled: false,
        realtimeEnabled: true,
        apiAutoExposeNewTables: Option.none(),
        vaultNames: ["a_secret"],
      }),
    ).pipe(
      Effect.tap((inputs) =>
        Effect.sync(() => {
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
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reads roles.sql content and resolves the effective auto-expose bool", () => {
    const dir = withTemp();
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(join(dir, "supabase", "roles.sql"), "create role app;");
    return withServices((fs, path) =>
      legacyResolveSetupInputs(fs, path, dir, 17, undefined, {
        authEnabled: true,
        storageEnabled: true,
        realtimeEnabled: true,
        apiAutoExposeNewTables: Option.some(true),
        vaultNames: [],
      }),
    ).pipe(
      Effect.tap((inputs) =>
        Effect.sync(() => {
          expect(inputs.rolesSql).toBe("create role app;");
          expect(inputs.autoExpose).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
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
      const dir = withTemp();
      const tempDir = join(dir, "pgdelta");
      mkdirSync(tempDir, { recursive: true });
      for (const ts of [100, 300, 200]) {
        writeFileSync(join(tempDir, `catalog-local-migrations-h-${ts}.json`), "{}");
      }
      return withServices((fs, path) =>
        Effect.gen(function* () {
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
      ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
    },
  );

  it.effect("creates the temp dir when it doesn't exist yet", () => {
    const dir = withTemp();
    const tempDir = join(dir, "pgdelta");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        yield* legacyWriteMigrationCatalogSnapshot(fs, path, tempDir, "local", "h", "{}", 100);
        expect(yield* fs.exists(join(tempDir, "catalog-local-migrations-h-100.json"))).toBe(true);
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
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
      const dir = withTemp();
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      // Mirrors `legacyPgDeltaTempPath` (`<workdir>/supabase/.temp/pgdelta`).
      const tempDir = join(dir, "supabase", ".temp", "pgdelta");
      const beforeCallMillis = Date.now();
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
        cwd: dir,
        npmVersion: undefined,
        denoVersion: 1,
      };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer, edge, sslProbe)),
        Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      );
    },
  );
});

describe("legacyCleanupOldMigrationCatalogs", () => {
  it.effect("only prunes files matching the given prefix's family", () => {
    const dir = withTemp();
    const tempDir = join(dir, "pgdelta");
    mkdirSync(tempDir, { recursive: true });
    for (const ts of [100, 200, 300]) {
      writeFileSync(join(tempDir, `catalog-local-migrations-h-${ts}.json`), "{}");
    }
    writeFileSync(join(tempDir, "catalog-other-migrations-h-50.json"), "{}");
    return withServices((fs, path) =>
      Effect.gen(function* () {
        yield* legacyCleanupOldMigrationCatalogs(fs, path, tempDir, "local");
        const remaining = (yield* fs.readDirectory(tempDir)).sort();
        expect(remaining).toEqual([
          "catalog-local-migrations-h-200.json",
          "catalog-local-migrations-h-300.json",
          "catalog-other-migrations-h-50.json",
        ]);
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
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
      const dir = withTemp();
      const tempDir = join(dir, "pgdelta");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, "catalog-local-migrations-h-100.json"), "{}");
      chmodSync(tempDir, 0o000);
      return withServices((fs, path) =>
        legacyCleanupOldMigrationCatalogs(fs, path, tempDir, "local").pipe(Effect.exit),
      ).pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            chmodSync(tempDir, 0o755);
            expect(Exit.isFailure(exit)).toBe(true);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
