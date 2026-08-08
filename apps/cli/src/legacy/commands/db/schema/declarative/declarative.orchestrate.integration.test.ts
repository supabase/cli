import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../../../../tests/helpers/mocks.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "../../shared/legacy-pgdelta-engine.legacy.layer.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDeclarativePlanInput,
} from "../../shared/legacy-pgdelta-engine.service.ts";
import {
  legacyBaselineCatalogFileName,
  legacyBaselineCatalogKey,
  legacyHashMigrations,
  legacyMigrationCatalogFileName,
  legacyMigrationsCatalogCacheKey,
  legacySetupInputsToken,
  type LegacySetupInputs,
} from "../../../../shared/legacy-pgdelta.cache.ts";
import {
  type LegacyCatalogMode,
  LegacyDeclarativeSeam,
} from "../../shared/legacy-pgdelta.seam.service.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyDiffDeclarativeToMigrations,
  legacyGenerateDeclarativeOutput,
} from "./declarative.orchestrate.ts";

function mockSeam(paths: Record<LegacyCatalogMode, string>) {
  const calls: Array<{ mode: LegacyCatalogMode; noCache: boolean }> = [];
  const provisionCalls: Array<{
    mode: string;
    projectRef?: string;
  }> = [];
  const removedContainers: string[] = [];
  const layer = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode, noCache }) => {
      calls.push({ mode, noCache });
      return Effect.succeed(paths[mode]);
    },
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () => Effect.void,
    provisionNextShadow: () => Effect.die("provisionNextShadow not used in declarative tests"),
    // The migrations-catalog source now resolves natively (CLI-1959) via
    // `legacyGetMigrationsCatalogRef`, which provisions its shadow through this
    // EXISTING `provisionShadow` (Go's unchanged `db __shadow --mode diff`) rather
    // than the retired `exportCatalog({mode:"migrations"})` seam call.
    provisionShadow: ({ mode, projectRef }) => {
      provisionCalls.push({ mode, projectRef });
      return Effect.succeed({
        container: "shadow-1",
        sourceUrl: "postgres://postgres:postgres@127.0.0.1:54320/postgres",
        targetUrlOverride: undefined,
      });
    },
    removeShadowContainer: (container) =>
      Effect.sync(() => {
        removedContainers.push(container);
      }),
  });
  return { layer, calls, provisionCalls, removedContainers };
}

function mockEdge(stdout: string) {
  const calls: LegacyEdgeRuntimeRunOpts[] = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (opts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(opts);
      // The catalog-export script (uniquely identified by its errPrefix) backs the
      // native migrations-catalog resolution's shadow export — return a fixed,
      // non-empty snapshot so it never trips `legacyExportCatalogPgDelta`'s
      // empty-output check regardless of what `stdout` the diff/export scripts use.
      if (opts.errPrefix === "error exporting pg-delta catalog") {
        return Effect.succeed({ stdout: '{"schemas":[]}', stderr: "" });
      }
      // The pg-delta diff script (uniquely identified by `renderPlanFiles`) prints a
      // JSON envelope with one file per plan unit; wrap the test's raw SQL into a
      // single-unit envelope so `legacyDiffPgDelta` parses it. Other scripts
      // (declarative export) return their stdout unchanged.
      const wrapped =
        opts.script.includes("renderPlanFiles") && stdout.length > 0
          ? JSON.stringify({
              version: 1,
              files: [
                { order: 1, name: "schema_changes", transactionMode: "transactional", sql: stdout },
              ],
            })
          : stdout;
      return Effect.succeed({ stdout: wrapped, stderr: "" });
    },
  });
  return { layer, calls };
}

// Remote refs in these tests are non-Supabase hosts that refuse TLS → probe
// reports "not required", so no CA bundle/SSL env is injected.
const probe = Layer.succeed(LegacyPgDeltaSslProbe, {
  requireSsl: () => Effect.succeed(false),
  requireSslForHost: () => Effect.succeed(false),
});

const ctx = (cwd: string, declarativeDir: string): LegacyDeclarativeRunContext => ({
  pgDelta: { projectId: "cferry", cwd, npmVersion: undefined, denoVersion: 2 },
  formatOptions: "",
  declarativeDir,
  schema: [],
  noCache: false,
  debug: false,
  dnsResolver: "native",
});

const engineLayer = (
  seam: Layer.Layer<LegacyDeclarativeSeam>,
  edge: Layer.Layer<LegacyEdgeRuntimeScript>,
  output: ReturnType<typeof mockOutput>["layer"],
) =>
  legacyPgDeltaLegacyEngineLayer.pipe(
    Layer.provide(Layer.mergeAll(seam, edge, probe, output, BunServices.layer)),
  );

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect("loads nested SQL and its manifest in stable order for the engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(join(declDir, "nested"), { recursive: true });
    writeFileSync(join(declDir, "z.sql"), "select 'z';");
    writeFileSync(join(declDir, "nested", "a.sql"), "select 'a';");
    writeFileSync(join(declDir, "ignored.txt"), "ignored");
    writeFileSync(
      join(declDir, ".pgdelta-export.json"),
      JSON.stringify({ formatVersion: 1, redactSecrets: true, scope: "database" }),
    );
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "next",
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: false,
            sql: "",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
            removals: {
              extensions: ["pgcrypto"],
              extensionIntents: [
                { extension: "pg_cron", intentKind: "job", key: "refresh metrics" },
              ],
            },
          });
        },
      }),
    );
    return legacyDiffDeclarativeToMigrations(
      { ...ctx(dir, declDir), debug: true, noCache: true },
      setupInputs,
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(calls[0]?.files).toEqual([
            { name: "nested/a.sql", sql: "select 'a';" },
            { name: "z.sql", sql: "select 'z';" },
          ]);
          expect(calls[0]?.manifest).toEqual({ redactSecrets: true, scope: "database" });
          expect(calls[0]?.debug).toBe(true);
          expect(calls[0]?.noCache).toBe(true);
          expect(result.manifestPresent).toBe(true);
          expect(result.removals).toEqual({
            extensions: ["pgcrypto"],
            extensionIntents: [{ extension: "pg_cron", intentKind: "job", key: "refresh metrics" }],
          });
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });
});

// A minimal, valid `LegacySetupInputs` — the exact field values don't matter to
// these tests (they only exercise the cache-miss/shadow-provision path), only
// that a real cache key can be derived from them.
const setupInputs: LegacySetupInputs = {
  image: "supabase/postgres:17.6.1.135",
  majorVersion: 17,
  authEnabled: true,
  storageEnabled: true,
  realtimeEnabled: true,
  autoExpose: false,
  vaultNames: [],
  rolesSql: "",
};

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect(
    "resolves the migrations catalog natively and diffs it against the seam-provisioned declarative catalog",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
      const declDir = join(dir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      const seam = mockSeam({
        declarative: "supabase/.temp/pgdelta/decl.json",
        baseline: "supabase/.temp/pgdelta/base.json",
      });
      const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\nDROP TABLE z;\n");
      const out = mockOutput();
      return legacyDiffDeclarativeToMigrations(ctx(dir, declDir), setupInputs).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // "declarative" still resolves via the seam; "migrations" no longer does
            // (it resolves natively, provisioning through `provisionShadow` instead).
            expect(seam.calls.map((c) => c.mode)).toEqual(["declarative"]);
            expect(seam.provisionCalls).toEqual([{ mode: "diff", projectRef: undefined }]);
            expect(seam.removedContainers).toEqual(["shadow-1"]);
            // No local migrations in the fresh temp dir → the zero-migrations branch
            // writes (and returns) the platform-baseline catalog, workdir-relative.
            expect(result.sourceRef).toMatch(
              /^supabase[/\\]\.temp[/\\]pgdelta[/\\]catalog-baseline-.*\.json$/,
            );
            expect(readFileSync(join(dir, result.sourceRef), "utf8")).toBe('{"schemas":[]}');
            expect(result.targetRef).toBe("supabase/.temp/pgdelta/decl.json");
            expect(result.diffSQL).toContain("ALTER TABLE x");
            expect(result.dropWarnings).toEqual(["DROP TABLE z"]);
            // The edge-runtime diff received the migrations ref (workdir-relative,
            // mapped to /workspace) and the seam's declarative ref as SOURCE/TARGET.
            const diffCall = edge.calls.find((c) => c.script.includes("renderPlanFiles"));
            expect(diffCall?.env["SOURCE"]).toBe(`/workspace/${result.sourceRef}`);
            expect(diffCall?.env["TARGET"]).toBe("/workspace/supabase/.temp/pgdelta/decl.json");
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer),
            BunServices.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "reuses an already-warmed platform-baseline catalog without provisioning a shadow",
    () => {
      // A baseline catalog pre-warmed by a prior generate/sync run (same setup
      // inputs, still zero local migrations) must be reused as-is — this is the
      // whole point of the zero-migrations special case in
      // `legacyGetMigrationsCatalogRef` (mirrors Go's `getMigrationsCatalogRef`,
      // `declarative.go:380-392`).
      const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
      const declDir = join(dir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      const tempDir = join(dir, "supabase", ".temp", "pgdelta");
      mkdirSync(tempDir, { recursive: true });
      const baselineKey = legacyBaselineCatalogKey(setupInputs);
      const baselinePath = join(tempDir, legacyBaselineCatalogFileName(baselineKey));
      writeFileSync(baselinePath, '{"warmed":true}');
      const seam = mockSeam({
        declarative: "supabase/.temp/pgdelta/decl.json",
        baseline: "supabase/.temp/pgdelta/base.json",
      });
      const edge = mockEdge("ALTER TABLE x;\n");
      const out = mockOutput();
      return legacyDiffDeclarativeToMigrations(ctx(dir, declDir), setupInputs).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(seam.provisionCalls).toEqual([]);
            expect(result.sourceRef).toBe(
              join("supabase", ".temp", "pgdelta", `catalog-baseline-${baselineKey}.json`),
            );
            expect(readFileSync(baselinePath, "utf8")).toBe('{"warmed":true}');
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer),
            BunServices.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "with local migrations present and cache enabled, provisions a shadow and caches the resulting catalog",
    () => {
      // The dominant real-world code path (a project WITH local migrations, cache
      // enabled) — `legacyGetMigrationsCatalogRef`'s cache-miss/non-zero-migrations
      // branch (declarative.go:393-430) — was previously never exercised by any
      // test; every other test here uses a fresh temp dir with zero migrations.
      const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
      const declDir = join(dir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20240101000000_init.sql"), "create table a();\n");
      const seam = mockSeam({
        declarative: "supabase/.temp/pgdelta/decl.json",
        baseline: "supabase/.temp/pgdelta/base.json",
      });
      const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\n");
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
        const key = legacyMigrationsCatalogCacheKey(
          legacySetupInputsToken(setupInputs),
          migrationsHash,
        );
        const result = yield* legacyDiffDeclarativeToMigrations(ctx(dir, declDir), setupInputs);
        expect(result.sourceRef).toMatch(
          new RegExp(
            `^supabase[/\\\\]\\.temp[/\\\\]pgdelta[/\\\\]catalog-local-migrations-${key}-\\d+\\.json$`,
          ),
        );
        expect(readFileSync(join(dir, result.sourceRef), "utf8")).toBe('{"schemas":[]}');
        expect(out.stderrText).toContain("Creating shadow database...\n");
        expect(seam.provisionCalls).toEqual([{ mode: "diff", projectRef: undefined }]);
        expect(seam.removedContainers).toEqual(["shadow-1"]);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer),
            BunServices.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "reuses an already-cached migrations catalog for local migrations without provisioning a new shadow",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
      const declDir = join(dir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20240101000000_init.sql"), "create table a();\n");
      const tempDir = join(dir, "supabase", ".temp", "pgdelta");
      mkdirSync(tempDir, { recursive: true });
      const seam = mockSeam({
        declarative: "supabase/.temp/pgdelta/decl.json",
        baseline: "supabase/.temp/pgdelta/base.json",
      });
      const edge = mockEdge("ALTER TABLE x;\n");
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
        const key = legacyMigrationsCatalogCacheKey(
          legacySetupInputsToken(setupInputs),
          migrationsHash,
        );
        const cachedPath = join(
          tempDir,
          legacyMigrationCatalogFileName("local", key, 1_700_000_000_000),
        );
        writeFileSync(cachedPath, '{"cached":true}');
        const result = yield* legacyDiffDeclarativeToMigrations(ctx(dir, declDir), setupInputs);
        expect(result.sourceRef).toBe(path.relative(dir, cachedPath));
        expect(readFileSync(cachedPath, "utf8")).toBe('{"cached":true}');
        expect(seam.provisionCalls).toEqual([]);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer),
            BunServices.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "--no-cache ignores an already-cached migrations catalog, provisions a fresh shadow, and writes catalog-nocache-migrations.json",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
      const declDir = join(dir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20240101000000_init.sql"), "create table a();\n");
      const tempDir = join(dir, "supabase", ".temp", "pgdelta");
      mkdirSync(tempDir, { recursive: true });
      const seam = mockSeam({
        declarative: "supabase/.temp/pgdelta/decl.json",
        baseline: "supabase/.temp/pgdelta/base.json",
      });
      const edge = mockEdge("ALTER TABLE x;\n");
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Pre-warm the cache entry that a cache-enabled run would hit, proving
        // --no-cache really skips the lookup rather than merely never having
        // written that entry.
        const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
        const key = legacyMigrationsCatalogCacheKey(
          legacySetupInputsToken(setupInputs),
          migrationsHash,
        );
        const cachedPath = join(
          tempDir,
          legacyMigrationCatalogFileName("local", key, 1_700_000_000_000),
        );
        writeFileSync(cachedPath, '{"cached":true}');
        const result = yield* legacyDiffDeclarativeToMigrations(
          { ...ctx(dir, declDir), noCache: true },
          setupInputs,
        );
        expect(result.sourceRef).toBe(
          join("supabase", ".temp", "pgdelta", "catalog-nocache-migrations.json"),
        );
        expect(readFileSync(join(dir, result.sourceRef), "utf8")).toBe('{"schemas":[]}');
        expect(seam.provisionCalls).toEqual([{ mode: "diff", projectRef: undefined }]);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer),
            BunServices.layer,
          ),
        ),
      );
    },
  );
  it.effect("fails when the declarative dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const seam = mockSeam({ declarative: "d", baseline: "b" });
    const edge = mockEdge("");
    const out = mockOutput();
    return legacyDiffDeclarativeToMigrations(ctx(dir, join(dir, "missing")), setupInputs).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect((error as { message: string }).message).toContain(
              "No declarative schema directory found",
            );
          }
          expect(seam.calls).toEqual([]);
          expect(seam.provisionCalls).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          seam.layer,
          edge.layer,
          probe,
          out.layer,
          engineLayer(seam.layer, edge.layer, out.layer),
          BunServices.layer,
        ),
      ),
    );
  });
});

describe("legacyGenerateDeclarativeOutput", () => {
  it.effect("propagates debug and no-cache to the selected engine", () => {
    const calls: Array<{ readonly debug: boolean; readonly noCache: boolean }> = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "next",
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: (input) => {
          calls.push({ debug: input.debug, noCache: input.noCache });
          return Effect.succeed({ files: [] });
        },
        planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used"),
      }),
    );
    return legacyGenerateDeclarativeOutput(
      { ...ctx("/proj", "/proj/supabase/database"), debug: true, noCache: true },
      {
        kind: "database",
        ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        connectOptions: { isLocal: true, dnsResolver: "native" },
      },
    ).pipe(
      Effect.tap(() => Effect.sync(() => expect(calls).toEqual([{ debug: true, noCache: true }]))),
      Effect.provide(engine),
    );
  });

  it.effect("diffs the baseline catalog against the live DB and returns files", () => {
    const seam = mockSeam({
      declarative: "d",
      baseline: "supabase/.temp/pgdelta/base.json",
    });
    const payload = {
      version: 1,
      mode: "declarative",
      files: [{ path: "public.sql", order: 0, statements: 1, sql: "create table a();" }],
    };
    const edge = mockEdge(JSON.stringify(payload));
    const out = mockOutput();
    return legacyGenerateDeclarativeOutput(ctx("/proj", "/proj/supabase/database"), {
      kind: "database",
      ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
      connectOptions: { isLocal: true, dnsResolver: "native" },
    }).pipe(
      Effect.tap((output) =>
        Effect.sync(() => {
          expect(seam.calls).toEqual([{ mode: "baseline", noCache: false }]);
          expect(output.files[0]?.name).toBe("public.sql");
          // SOURCE = baseline catalog (mapped to /workspace); TARGET = live URL (passthrough).
          expect(edge.calls[0]!.env["SOURCE"]).toBe("/workspace/supabase/.temp/pgdelta/base.json");
          expect(edge.calls[0]!.env["TARGET"]).toBe(
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          seam.layer,
          edge.layer,
          probe,
          out.layer,
          engineLayer(seam.layer, edge.layer, out.layer),
          BunServices.layer,
        ),
      ),
    );
  });
});
