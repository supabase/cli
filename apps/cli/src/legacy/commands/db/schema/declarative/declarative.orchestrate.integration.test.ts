import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { mockLegacyShadowContainerCliSpawner } from "../../../../../../tests/helpers/legacy-mocks.ts";
import { alwaysReadyHttpClientLayer } from "../../../../../../tests/helpers/legacy-local-reset.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../../shared/legacy/global-flags.ts";
import type { LegacyDbTomlValues } from "../../../../shared/legacy-db-config.toml-read.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../../shared/legacy-docker-run.service.ts";
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
import { makeLegacyViperEnvLayer } from "../../../../../shared/legacy/legacy-viper-env.ts";

const legacyViperEnvLayer = makeLegacyViperEnvLayer(
  ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
);

function mockSeam(paths: Record<LegacyCatalogMode, string>) {
  const calls: Array<{ mode: LegacyCatalogMode; noCache: boolean }> = [];
  const layer = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode, noCache }) => {
      calls.push({ mode, noCache });
      return Effect.succeed(paths[mode]);
    },
    ensureLocalDatabaseStarted: Effect.void,
    ensureLocalPostgresImageCurrent: Effect.void,
  });
  return { layer, calls };
}

/**
 * The native shadow-provisioning stack `legacyGetMigrationsCatalogRef`'s
 * cache-miss path needs (CLI-1956): the SAME `legacyCreateShadowDatabase`/
 * `legacyPrepareShadowSource`/`legacyRemoveShadowDatabase` primitives `db diff`/
 * `db pull` use for their own shadow, not the retired `db __shadow` seam — see
 * `legacy-pgdelta.cache.ts`'s `exportViaShadowCatalog` doc comment. Mirrors
 * `diff.integration.test.ts`'s own shadow mocks (`mockLegacyShadowContainerCliSpawner`
 * + a fake `LegacyDbConnection`/`LegacyDockerRun`), scoped down to this file's
 * lower-level, seam-free tests.
 */
function mockShadowInfra() {
  const spawner = mockLegacyShadowContainerCliSpawner();
  const connectedDatabases: Array<string> = [];
  const dbConnection = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: LegacyPgConnInput) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        const session: LegacyDbSession = {
          exec: () => Effect.void,
          execBatch: () => Effect.void,
          query: () => Effect.succeed([]),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });
  // The shadow's own PG15+ one-shot platform-baseline job(s) — Go's `initSchema15`.
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: () => Effect.succeed({ exitCode: 0, stderr: "" }),
  });
  const layer = Layer.mergeAll(
    spawner.layer,
    dbConnection,
    docker,
    mockRuntimeInfo(),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyExperimentalFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    alwaysReadyHttpClientLayer,
  );
  return { layer, spawned: spawner.spawned, connectedDatabases };
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
  pgDelta: {
    projectId: "cferry",
    cwd,
    npmVersion: undefined,
    denoVersion: 2,
    projectEnv: {},
  },
  formatOptions: "",
  declarativeDir,
  declarativeDirDisplay: declarativeDir,
  schema: [],
  noCache: false,
  debug: false,
  strictCoverage: false,
  dnsResolver: "native",
});

const engineLayer = (
  seam: Layer.Layer<LegacyDeclarativeSeam>,
  edge: Layer.Layer<LegacyEdgeRuntimeScript>,
  output: ReturnType<typeof mockOutput>["layer"],
  runtime: ReturnType<typeof mockShadowInfra>["layer"],
) =>
  legacyPgDeltaLegacyEngineLayer.pipe(
    Layer.provide(
      Layer.mergeAll(seam, edge, probe, output, BunServices.layer, runtime, legacyViperEnvLayer),
    ),
  );

const withTempWorkdir = <A, E, R>(
  run: (fs: FileSystem.FileSystem, path: Path.Path, workdir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-orch-" });
    return yield* run(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect("loads nested SQL and its manifest in stable order for the engine", () => {
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
            changes: true,
            sql: "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
            hazards: {
              actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
              dataLoss: [
                {
                  actionIndex: 0,
                  sql: "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
                },
              ],
              coverage: ["data_loss"],
              kinds: ["data_loss"],
            },
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
    return withTempWorkdir((fs, path, dir) => {
      const declDir = path.join(dir, "supabase", "database");
      return Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(declDir, "nested"), { recursive: true });
        yield* fs.writeFileString(path.join(declDir, "z.sql"), "select 'z';");
        yield* fs.writeFileString(path.join(declDir, "nested", "a.sql"), "select 'a';");
        yield* fs.writeFileString(path.join(declDir, "ignored.txt"), "ignored");
        yield* fs.writeFileString(
          path.join(declDir, ".pgdelta-export.json"),
          '{"formatVersion":1,"redactSecrets":true,"scope":"database"}',
        );
        const result = yield* legacyDiffDeclarativeToMigrations(
          { ...ctx(dir, declDir), debug: true, noCache: true, strictCoverage: true },
          toml,
          setupInputs,
        );
        expect(calls[0]?.files).toEqual([
          { name: "nested/a.sql", sql: "select 'a';" },
          { name: "z.sql", sql: "select 'z';" },
        ]);
        expect(calls[0]?.manifest).toEqual({ redactSecrets: true, scope: "database" });
        expect(calls[0]?.debug).toBe(true);
        expect(calls[0]?.noCache).toBe(true);
        expect(calls[0]?.strictCoverage).toBe(true);
        expect(result.manifestPresent).toBe(true);
        expect(result.dropWarnings).toEqual([
          "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
        ]);
        expect(result.removals).toEqual({
          extensions: ["pgcrypto"],
          extensionIntents: [{ extension: "pg_cron", intentKind: "job", key: "refresh metrics" }],
        });
      }).pipe(Effect.provide(Layer.mergeAll(engine, BunServices.layer)));
    });
  });

  // The legacy engine's `planDeclarativeSchema` never looks at `input.manifest`, so
  // validating the manifest for it turned a stale/hand-edited `.pgdelta-export.json`
  // into a hard failure of the documented `SUPABASE_USE_PG_DELTA_NEXT=false` escape
  // hatch. The next engine, which does consume it, must still reject it.
  const stubEngine = (
    implementation: "legacy" | "next",
    calls: LegacyPgDeltaDeclarativePlanInput[],
  ) =>
    Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation,
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: true,
            sql: "create table public.accounts();",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
          });
        },
      }),
    );

  const withCorruptManifest = (fs: FileSystem.FileSystem, path: Path.Path, dir: string) => {
    const declDir = path.join(dir, "supabase", "database");
    return Effect.gen(function* () {
      yield* fs.makeDirectory(declDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(declDir, "public.sql"),
        "create table public.accounts();",
      );
      yield* fs.writeFileString(path.join(declDir, ".pgdelta-export.json"), "{ not json at all");
      return declDir;
    });
  };

  it.effect("ignores a corrupt export manifest under the legacy engine opt-out", () => {
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    return withTempWorkdir((fs, path, dir) =>
      Effect.gen(function* () {
        const declDir = yield* withCorruptManifest(fs, path, dir);
        const result = yield* legacyDiffDeclarativeToMigrations(
          ctx(dir, declDir),
          toml,
          setupInputs,
        );
        expect(calls[0]?.files).toEqual([
          { name: "public.sql", sql: "create table public.accounts();" },
        ]);
        expect(calls[0]?.manifest).toBeUndefined();
        expect(result.manifestPresent).toBe(false);
        expect(result.diffSQL).toBe("create table public.accounts();");
      }).pipe(Effect.provide(Layer.mergeAll(stubEngine("legacy", calls), BunServices.layer))),
    );
  });

  it.effect("still rejects a corrupt export manifest under the next engine", () => {
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    return withTempWorkdir((fs, path, dir) =>
      Effect.gen(function* () {
        const declDir = yield* withCorruptManifest(fs, path, dir);
        const exit = yield* legacyDiffDeclarativeToMigrations(
          ctx(dir, declDir),
          toml,
          setupInputs,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
          expect(String((error as { message?: string } | undefined)?.message)).toContain(
            "malformed export manifest",
          );
        }
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(stubEngine("next", calls), BunServices.layer))),
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

// A minimal, valid `LegacyDbTomlValues` — threaded into `legacyGetMigrationsCatalogRef`
// for the migrations-catalog shadow's own container spec (CLI-1956). Matches
// `legacy-db-config.toml-read.ts`'s own unconfigured defaults so this fixture
// doesn't silently drift from what `legacyReadDbToml` would resolve for these
// tests' bare temp dirs (none of them write a `config.toml`).
const toml: LegacyDbTomlValues = {
  projectEnv: {},
  envLookup: () => undefined,
  apiSchemas: ["public", "graphql_public"],
  port: 54322,
  shadowPort: 54320,
  password: "postgres",
  poolerConnectionString: Option.none(),
  projectId: Option.none(),
  majorVersion: 17,
  orioledbVersion: Option.none(),
  denoVersion: 2,
  pgDelta: {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    npmVersion: Option.none(),
  },
  webhooksEnabled: false,
  baseline: {
    authEnabled: true,
    storageEnabled: true,
    realtimeEnabled: true,
    apiAutoExposeNewTables: Option.none(),
    vaultNames: [],
  },
  migrationsEnabled: true,
  schemaPaths: [],
  schemaPathPatterns: [],
  seed: { enabled: true, sqlPaths: [] },
  vault: [],
  appliedRemote: undefined,
  remoteOverrideKeys: new Set(),
};

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect(
    "resolves the migrations catalog natively and diffs it against the seam-provisioned declarative catalog",
    () =>
      withTempWorkdir((fs, path, dir) => {
        const declDir = path.join(dir, "supabase", "database");
        const seam = mockSeam({
          declarative: "supabase/.temp/pgdelta/decl.json",
          baseline: "supabase/.temp/pgdelta/base.json",
        });
        const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\nDROP TABLE z;\n");
        const out = mockOutput();
        const shadow = mockShadowInfra();
        return Effect.gen(function* () {
          yield* fs.makeDirectory(declDir, { recursive: true });
          const result = yield* legacyDiffDeclarativeToMigrations(
            ctx(dir, declDir),
            toml,
            setupInputs,
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                seam.layer,
                edge.layer,
                probe,
                out.layer,
                engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
                shadow.layer,
                legacyViperEnvLayer,
              ),
            ),
          );
          // "declarative" still resolves via the seam; "migrations" no longer does
          // (it resolves natively, provisioning its shadow the same way `db diff`/
          // `db pull` do — CLI-1956).
          expect(seam.calls.map((c) => c.mode)).toEqual(["declarative"]);
          expect(shadow.spawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(shadow.spawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          // No local migrations in the fresh temp dir → the zero-migrations branch
          // writes (and returns) the platform-baseline catalog, workdir-relative.
          expect(result.sourceRef).toMatch(
            /^supabase[/\\]\.temp[/\\]pgdelta[/\\]catalog-baseline-.*\.json$/,
          );
          expect(yield* fs.readFileString(path.join(dir, result.sourceRef))).toBe('{"schemas":[]}');
          expect(result.targetRef).toBe("supabase/.temp/pgdelta/decl.json");
          expect(result.diffSQL).toContain("ALTER TABLE x");
          expect(result.dropWarnings).toEqual(["DROP TABLE z"]);
          const diffCall = edge.calls.find((c) => c.script.includes("renderPlanFiles"));
          expect(diffCall?.env["SOURCE"]).toBe(`/workspace/${result.sourceRef}`);
          expect(diffCall?.env["TARGET"]).toBe("/workspace/supabase/.temp/pgdelta/decl.json");
        });
      }),
  );

  // `--strict-coverage` is enforced entirely by the next engine's diagnostic report;
  // the legacy engine has no coverage diagnostics, so the flag silently did nothing
  // under `SUPABASE_USE_PG_DELTA_NEXT=false`. It must say so instead.
  const runWithStrictCoverageOnLegacyEngine = (dir: string, declDir: string) => {
    const seam = mockSeam({
      declarative: "supabase/.temp/pgdelta/decl.json",
      baseline: "supabase/.temp/pgdelta/base.json",
    });
    const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\n");
    const out = mockOutput();
    const shadow = mockShadowInfra();
    return {
      dir,
      out,
      effect: legacyDiffDeclarativeToMigrations(
        { ...ctx(dir, declDir), strictCoverage: true },
        toml,
        setupInputs,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
            BunServices.layer,
            shadow.layer,
          ),
        ),
      ),
    };
  };

  it.effect("warns that --strict-coverage does nothing on the legacy engine", () => {
    return withTempWorkdir((fs, path, dir) => {
      const declDir = path.join(dir, "supabase", "database");
      return Effect.gen(function* () {
        yield* fs.makeDirectory(declDir, { recursive: true });
        const { out, effect } = runWithStrictCoverageOnLegacyEngine(dir, declDir);
        yield* effect;
        expect(out.stderrText).toContain(
          '"--strict-coverage" has no effect with the legacy pg-delta engine.',
        );
      });
    });
  });

  it.effect(
    "reuses an already-warmed platform-baseline catalog without provisioning a shadow",
    () =>
      withTempWorkdir((fs, path, dir) =>
        Effect.gen(function* () {
          // A baseline catalog pre-warmed by a prior generate/sync run (same setup
          // inputs, still zero local migrations) must be reused as-is — this is the
          // whole point of the zero-migrations special case in
          // `legacyGetMigrationsCatalogRef` (mirrors Go's `getMigrationsCatalogRef`,
          // `declarative.go:380-392`).
          const declDir = path.join(dir, "supabase", "database");
          const tempDir = path.join(dir, "supabase", ".temp", "pgdelta");
          yield* fs.makeDirectory(declDir, { recursive: true });
          yield* fs.makeDirectory(tempDir, { recursive: true });
          const baselineKey = legacyBaselineCatalogKey(setupInputs);
          const baselinePath = path.join(tempDir, legacyBaselineCatalogFileName(baselineKey));
          yield* fs.writeFileString(baselinePath, '{"warmed":true}');
          const seam = mockSeam({
            declarative: "supabase/.temp/pgdelta/decl.json",
            baseline: "supabase/.temp/pgdelta/base.json",
          });
          const edge = mockEdge("ALTER TABLE x;\n");
          const out = mockOutput();
          const shadow = mockShadowInfra();
          const result = yield* legacyDiffDeclarativeToMigrations(
            ctx(dir, declDir),
            toml,
            setupInputs,
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                seam.layer,
                edge.layer,
                probe,
                out.layer,
                engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
                BunServices.layer,
                shadow.layer,
                legacyViperEnvLayer,
              ),
            ),
          );
          expect(shadow.spawned).toEqual([]);
          expect(result.sourceRef).toBe(
            path.join("supabase", ".temp", "pgdelta", `catalog-baseline-${baselineKey}.json`),
          );
          expect(yield* fs.readFileString(baselinePath)).toBe('{"warmed":true}');
        }).pipe(Effect.provide(BunServices.layer)),
      ),
  );

  it.effect(
    "fails when the zero-migrations baseline cache probe itself fails, before any shadow work",
    () =>
      withTempWorkdir((fs, path, dir) =>
        Effect.gen(function* () {
          // A probe failure that isn't not-found (permissions, I/O under `.temp/pgdelta`) must
          // propagate — matching Go's `getMigrationsCatalogRef` returning the `afero.Exists`
          // error immediately — instead of being converted into a cache miss that provisions a
          // Docker shadow and only surfaces the filesystem problem at the eventual write to the
          // same location (codex review, PR #6162).
          const declDir = path.join(dir, "supabase", "database");
          yield* fs.makeDirectory(declDir, { recursive: true });
          const baselineFileName = legacyBaselineCatalogFileName(
            legacyBaselineCatalogKey(setupInputs),
          );
          const seam = mockSeam({
            declarative: "supabase/.temp/pgdelta/decl.json",
            baseline: "supabase/.temp/pgdelta/base.json",
          });
          const edge = mockEdge("ALTER TABLE x;\n");
          const out = mockOutput();
          const shadow = mockShadowInfra();
          // Wraps the real Bun `FileSystem` so only the baseline probe fails, with a genuine
          // `PlatformError` (same construction as the cache unit tests' failing-fs fakes).
          // Merged LAST so it overrides `BunServices.layer`'s own `FileSystem`.
          const failingFsLayer = Layer.effect(
            FileSystem.FileSystem,
            Effect.gen(function* () {
              const real = yield* FileSystem.FileSystem;
              const err = yield* real
                .readDirectory(path.join(dir, "does-not-exist"))
                .pipe(Effect.flip);
              const failing: FileSystem.FileSystem = {
                ...real,
                exists: (p) => (p.endsWith(baselineFileName) ? Effect.fail(err) : real.exists(p)),
              };
              return failing;
            }),
          ).pipe(Layer.provide(BunServices.layer));
          const exit = yield* legacyDiffDeclarativeToMigrations(
            ctx(dir, declDir),
            toml,
            setupInputs,
          ).pipe(
            Effect.exit,
            Effect.provide(
              Layer.mergeAll(
                BunServices.layer,
                seam.layer,
                edge.layer,
                probe,
                out.layer,
                shadow.layer,
                legacyPgDeltaLegacyEngineLayer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      seam.layer,
                      edge.layer,
                      probe,
                      out.layer,
                      BunServices.layer,
                      shadow.layer,
                      failingFsLayer,
                      legacyViperEnvLayer,
                    ),
                  ),
                ),
                failingFsLayer,
                legacyViperEnvLayer,
              ),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(shadow.spawned).toEqual([]);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
  );

  it.effect(
    "with local migrations present and cache enabled, provisions a shadow and caches the resulting catalog",
    () =>
      withTempWorkdir((fs, path, dir) => {
        const seam = mockSeam({
          declarative: "supabase/.temp/pgdelta/decl.json",
          baseline: "supabase/.temp/pgdelta/base.json",
        });
        const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\n");
        const out = mockOutput();
        const shadow = mockShadowInfra();
        return Effect.gen(function* () {
          // The dominant real-world code path (a project WITH local migrations, cache
          // enabled) — `legacyGetMigrationsCatalogRef`'s cache-miss/non-zero-migrations
          // branch (declarative.go:393-430) — was previously never exercised by any
          // test; every other test here uses a fresh temp dir with zero migrations.
          const declDir = path.join(dir, "supabase", "database");
          yield* fs.makeDirectory(declDir, { recursive: true });
          const migrationsDir = path.join(dir, "supabase", "migrations");
          yield* fs.makeDirectory(migrationsDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(migrationsDir, "20240101000000_init.sql"),
            "create table a();\n",
          );
          const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
          const key = legacyMigrationsCatalogCacheKey(
            legacySetupInputsToken(setupInputs),
            migrationsHash,
          );
          const result = yield* legacyDiffDeclarativeToMigrations(
            ctx(dir, declDir),
            toml,
            setupInputs,
          );
          expect(result.sourceRef).toMatch(
            new RegExp(
              `^supabase[/\\\\]\\.temp[/\\\\]pgdelta[/\\\\]catalog-local-migrations-${key}-\\d+\\.json$`,
            ),
          );
          expect(yield* fs.readFileString(path.join(dir, result.sourceRef))).toBe('{"schemas":[]}');
          expect(out.stderrText).toContain("Creating shadow database...\n");
          expect(shadow.spawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(shadow.spawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              seam.layer,
              edge.layer,
              probe,
              out.layer,
              engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
              BunServices.layer,
              shadow.layer,
            ),
          ),
        );
      }),
  );

  it.effect(
    "reuses an already-cached migrations catalog for local migrations without provisioning a new shadow",
    () =>
      withTempWorkdir((fs, path, dir) => {
        const seam = mockSeam({
          declarative: "supabase/.temp/pgdelta/decl.json",
          baseline: "supabase/.temp/pgdelta/base.json",
        });
        const edge = mockEdge("ALTER TABLE x;\n");
        const out = mockOutput();
        const shadow = mockShadowInfra();
        return Effect.gen(function* () {
          const declDir = path.join(dir, "supabase", "database");
          yield* fs.makeDirectory(declDir, { recursive: true });
          const migrationsDir = path.join(dir, "supabase", "migrations");
          yield* fs.makeDirectory(migrationsDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(migrationsDir, "20240101000000_init.sql"),
            "create table a();\n",
          );
          const tempDir = path.join(dir, "supabase", ".temp", "pgdelta");
          yield* fs.makeDirectory(tempDir, { recursive: true });
          const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
          const key = legacyMigrationsCatalogCacheKey(
            legacySetupInputsToken(setupInputs),
            migrationsHash,
          );
          const cachedPath = path.join(
            tempDir,
            legacyMigrationCatalogFileName("local", key, 1_700_000_000_000),
          );
          yield* fs.writeFileString(cachedPath, '{"cached":true}');
          const result = yield* legacyDiffDeclarativeToMigrations(
            ctx(dir, declDir),
            toml,
            setupInputs,
          );
          expect(result.sourceRef).toBe(path.relative(dir, cachedPath));
          expect(yield* fs.readFileString(cachedPath)).toBe('{"cached":true}');
          expect(shadow.spawned).toEqual([]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              seam.layer,
              edge.layer,
              probe,
              out.layer,
              engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
              BunServices.layer,
              shadow.layer,
            ),
          ),
        );
      }),
  );

  it.effect(
    "--no-cache ignores an already-cached migrations catalog, provisions a fresh shadow, and writes catalog-nocache-migrations.json",
    () =>
      withTempWorkdir((fs, path, dir) => {
        const seam = mockSeam({
          declarative: "supabase/.temp/pgdelta/decl.json",
          baseline: "supabase/.temp/pgdelta/base.json",
        });
        const edge = mockEdge("ALTER TABLE x;\n");
        const out = mockOutput();
        const shadow = mockShadowInfra();
        return Effect.gen(function* () {
          const declDir = path.join(dir, "supabase", "database");
          yield* fs.makeDirectory(declDir, { recursive: true });
          const migrationsDir = path.join(dir, "supabase", "migrations");
          yield* fs.makeDirectory(migrationsDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(migrationsDir, "20240101000000_init.sql"),
            "create table a();\n",
          );
          const tempDir = path.join(dir, "supabase", ".temp", "pgdelta");
          yield* fs.makeDirectory(tempDir, { recursive: true });
          // Pre-warm the cache entry that a cache-enabled run would hit, proving
          // --no-cache really skips the lookup rather than merely never having
          // written that entry.
          const migrationsHash = yield* legacyHashMigrations(fs, path, dir, migrationsDir);
          const key = legacyMigrationsCatalogCacheKey(
            legacySetupInputsToken(setupInputs),
            migrationsHash,
          );
          const cachedPath = path.join(
            tempDir,
            legacyMigrationCatalogFileName("local", key, 1_700_000_000_000),
          );
          yield* fs.writeFileString(cachedPath, '{"cached":true}');
          const result = yield* legacyDiffDeclarativeToMigrations(
            { ...ctx(dir, declDir), noCache: true },
            toml,
            setupInputs,
          );
          expect(result.sourceRef).toBe(
            path.join("supabase", ".temp", "pgdelta", "catalog-nocache-migrations.json"),
          );
          expect(yield* fs.readFileString(path.join(dir, result.sourceRef))).toBe('{"schemas":[]}');
          expect(shadow.spawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              seam.layer,
              edge.layer,
              probe,
              out.layer,
              engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
              BunServices.layer,
              shadow.layer,
            ),
          ),
        );
      }),
  );
  it.effect("fails when the declarative dir is absent", () =>
    withTempWorkdir((fs, path, dir) => {
      const seam = mockSeam({ declarative: "d", baseline: "b" });
      const edge = mockEdge("");
      const out = mockOutput();
      const shadow = mockShadowInfra();
      return Effect.gen(function* () {
        const exit = yield* legacyDiffDeclarativeToMigrations(
          ctx(dir, path.join(dir, "missing")),
          toml,
          setupInputs,
        ).pipe(
          Effect.exit,
          Effect.provide(
            Layer.mergeAll(
              seam.layer,
              edge.layer,
              probe,
              out.layer,
              engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
              shadow.layer,
              legacyViperEnvLayer,
            ),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
          expect((error as { message: string }).message).toContain(
            "No declarative schema directory found",
          );
        }
        expect(seam.calls).toEqual([]);
        expect(shadow.spawned).toEqual([]);
      });
    }),
  );
});

describe("legacyGenerateDeclarativeOutput", () => {
  it.effect("propagates debug, no-cache, and strict coverage to the selected engine", () =>
    withTempWorkdir((_fs, path, dir) => {
      const calls: Array<{
        readonly debug: boolean;
        readonly noCache: boolean;
        readonly sourceRef: string | undefined;
        readonly strictCoverage: boolean;
      }> = [];
      const engine = Layer.succeed(
        LegacyPgDeltaEngine,
        LegacyPgDeltaEngine.of({
          implementation: "next",
          diffExplicit: () => Effect.die("diffExplicit not used"),
          diffDatabase: () => Effect.die("diffDatabase not used"),
          exportDeclarativeSchema: (input) => {
            calls.push({
              debug: input.debug,
              noCache: input.noCache,
              sourceRef: input.source?.ref,
              strictCoverage: input.strictCoverage,
            });
            return Effect.succeed({ files: [] });
          },
          planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used"),
        }),
      );
      const shadow = mockShadowInfra();
      const out = mockOutput();
      return legacyGenerateDeclarativeOutput(
        {
          ...ctx(dir, path.join(dir, "supabase", "database")),
          debug: true,
          noCache: true,
          strictCoverage: true,
        },
        toml,
        {
          kind: "database",
          ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(calls).toEqual([
              {
                debug: true,
                noCache: true,
                sourceRef: undefined,
                strictCoverage: true,
              },
            ]);
            expect(shadow.spawned).toEqual([]);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(engine, out.layer, BunServices.layer, shadow.layer, legacyViperEnvLayer),
        ),
      );
    }),
  );

  it.effect("diffs a native raw shadow against the live DB and returns files", () =>
    withTempWorkdir((_fs, path, dir) => {
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
      const shadow = mockShadowInfra();
      return legacyGenerateDeclarativeOutput(
        ctx(dir, path.join(dir, "supabase", "database")),
        toml,
        {
          kind: "database",
          ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      ).pipe(
        Effect.tap((output) =>
          Effect.sync(() => {
            expect(seam.calls).toEqual([]);
            expect(output.files[0]?.name).toBe("public.sql");
            expect(edge.calls[0]!.env["SOURCE"]).toBe(
              "postgresql://postgres:postgres@127.0.0.1:54320/postgres?connect_timeout=10",
            );
            expect(edge.calls[0]!.env["TARGET"]).toBe(
              "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
            );
            expect(shadow.spawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
            expect(shadow.spawned.filter((call) => call.args[0] === "rm")).toHaveLength(1);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            seam.layer,
            edge.layer,
            probe,
            out.layer,
            engineLayer(seam.layer, edge.layer, out.layer, shadow.layer),
            BunServices.layer,
            shadow.layer,
            legacyViperEnvLayer,
          ),
        ),
      );
    }),
  );
});
