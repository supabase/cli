import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  type LegacySetupInputs,
  legacyBaselineCatalogFileName,
  legacyBaselineCatalogKey,
  legacyBaselineVersionToken,
  legacyCleanupOldDeclarativeCatalogs,
  legacyDeclarativeCatalogCacheKey,
  legacyDeclarativeCatalogFileName,
  legacyHashDeclarativeSchemas,
  legacyHashMigrations,
  legacyListLocalMigrations,
  legacyResolveDeclarativeCatalogPath,
  legacySanitizedCatalogPrefix,
  legacySetupInputsToken,
} from "./declarative.cache.ts";

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

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A>;

const withServices = <A>(
  body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, unknown, never>,
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
  it.effect("hashes path + contents in list order (stable, content-sensitive)", () => {
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const file = join(migrationsDir, "20240101120000_create.sql");
    writeFileSync(file, "create table x();");
    const expected = createHash("sha256")
      .update(file, "utf8")
      .update(Buffer.from("create table x();"))
      .digest("hex");
    return withServices((fs, path) => legacyHashMigrations(fs, path, migrationsDir)).pipe(
      Effect.tap((hash) =>
        Effect.sync(() => {
          expect(hash).toBe(expected);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
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
        const latest = yield* legacyResolveDeclarativeCatalogPath(fs, path, tempDir, "local", "h");
        expect(Option.getOrNull(latest)?.endsWith("catalog-local-declarative-h-300.json")).toBe(
          true,
        );
        yield* legacyCleanupOldDeclarativeCatalogs(fs, path, tempDir, "local");
        const remaining = (yield* fs.readDirectory(tempDir)).filter((n) =>
          n.startsWith("catalog-local-declarative-"),
        );
        // Retention keeps the 2 newest of the family (300, 200); 100 + other-50 pruned.
        expect(remaining.sort()).toEqual([
          "catalog-local-declarative-h-200.json",
          "catalog-local-declarative-h-300.json",
        ]);
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
  });
});
