/**
 * The shadow baseline cache's acquire/export/restore flow, driven end to end against a tiny
 * in-test Docker model (create/start/stop/rm all mutate the same container table, and `docker cp`
 * really moves bytes in and out of it) plus the REAL filesystem under a per-test temp workdir, so
 * the tar artifact, its atomic publish, and its retention rule are exercised for real.
 *
 * Scenario-oriented on purpose: every test is a sequence of real acquires and releases, and the
 * assertions are on the resulting Docker state, the tar on disk, and what the caller was told
 * about the baseline — not on internal call ordering, except where the ordering IS the contract
 * (the export must stop the container before copying and start it again afterwards).
 */

import { accessSync, chmodSync, constants } from "node:fs";
import { join } from "node:path";

import type { CliConfig } from "@supabase/config";
import { CliConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";

import {
  LEGACY_FAKE_EMPTY_TAR,
  LEGACY_FAKE_UNSTAMPED_PGDATA_TAR,
  legacyFakePgDataTar,
  legacyWithEnv,
  mockLegacyDockerDaemonCliSpawner,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { legacyShadowBaselineCacheDir } from "../legacy-pgdelta.paths.ts";
import {
  LEGACY_PGDATA_BASELINE_MARKER_ENTRY,
  LEGACY_PGDATA_BASELINE_MARKER_NAME,
  LEGACY_PGDATA_PARENT_PATH,
  LEGACY_PGDATA_PATH,
  legacyPgDataBaselineMarkerContent,
} from "./pgdata-snapshot.ts";
import {
  LEGACY_SHADOW_BASELINE_KEEP,
  LEGACY_SHADOW_CACHE_ENV,
  legacyAcquireShadowDatabase,
  type LegacyShadowCacheOpts,
} from "./shadow-cache.ts";
import { legacyRemoveShadowDatabase } from "./shadow-database.ts";
import type { LegacyShadowDbSetupInput, LegacyShadowSetupInput } from "./shadow-database.ts";

const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);
const defaultConfig: CliConfig = decodeConfig({});

const tempRoot = useLegacyTempWorkdir("legacy-shadow-cache-");

const withShadowCacheEnv = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  legacyWithEnv(LEGACY_SHADOW_CACHE_ENV, value, body);

/**
 * Isolates the global shadow-baseline cache under a per-test `SUPABASE_HOME` so tests never
 * write into the developer's real `~/.supabase`. Nested with the cache env gate.
 */
const withShadowCacheHome = <A, E, R>(
  value: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  legacyWithEnv(
    "SUPABASE_HOME",
    join(tempRoot.current, "_supabase_home"),
    withShadowCacheEnv(value, body),
  );

// ---------------------------------------------------------------------------
// A fake Postgres the readiness probe can connect to
// ---------------------------------------------------------------------------

function fakeCluster(opts: { readonly failConnect?: boolean } = {}) {
  const connected: Array<string> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg) =>
      Effect.suspend(() => {
        connected.push(cfg.database);
        return opts.failConnect === true
          ? Effect.fail(new LegacyDbConnectError({ message: "connection refused" }))
          : Effect.succeed({
              exec: () => Effect.void,
              query: () => Effect.succeed([]),
              execBatch: () => Effect.void,
              extensionExists: () => Effect.succeed(false),
              copyToCsv: () => Effect.succeed(new Uint8Array()),
              queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
            });
      }),
  });
  return { layer, connected };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const shadowSetup = (): LegacyShadowDbSetupInput<never> => ({
  majorVersion: 17,
  config: defaultConfig,
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54320/postgres",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwks: Effect.succeed('{"keys":[]}'),
  apiUrl: "http://127.0.0.1:54321",
  authExternalUrl: undefined,
  siteUrl: defaultConfig.auth.site_url,
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
  storageTargetMigration: "",
  realtimeEnabledForSetup: false,
  storageEnabledForSetup: false,
  authEnabledForSetup: false,
  serviceVersionOverrides: {},
  projectEnvValues: undefined,
  debug: false,
  webhooksEnabled: false,
  apiAutoExposeNewTables: Option.some(true),
  vault: [],
});

const shadowInput = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  overrides: { readonly shadowPort?: number; readonly jwtExpiry?: number } = {},
): LegacyShadowSetupInput<never> => ({
  db: { major_version: 17, settings: {} },
  experimental: defaultConfig.experimental,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: overrides.jwtExpiry ?? 3600,
  networkId: "supabase_network_proj",
  image: "public.ecr.aws/supabase/postgres:17.4.1.030",
  configImage: "supabase/postgres:17.4.1.030",
  shadowPort: overrides.shadowPort ?? 54320,
  password: "postgres",
  projectId: "proj",
  isBitbucketPipeline: false,
  workdir: tempRoot.current,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 2,
  setup: shadowSetup(),
});

const shadowCacheDir = (path: Path.Path) => legacyShadowBaselineCacheDir(path);

/** The snapshot tars in the global cache dir, whatever keys they belong to. */
const soleTarName = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, path: Path.Path) {
  const entries = yield* fs
    .readDirectory(shadowCacheDir(path))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return entries.filter((entry) => entry.endsWith(".tar"));
});

/** The cache key a published snapshot's filename (`shadow-baseline-<key>.tar`) is stored under. */
const keyOf = (tarName: string) => tarName.slice("shadow-baseline-".length, -".tar".length);

/**
 * What a correct cold export publishes under `tarName`: the fake PGDATA archive carrying the
 * baseline marker stamped with THAT filename's own key. Derived from the name rather than hardcoded
 * so the assertion fails if the export ever stamps a different key than it publishes under.
 */
const expectedTarFor = (tarName: string) =>
  legacyFakePgDataTar(legacyPgDataBaselineMarkerContent(keyOf(tarName)));

/** A full cold run: acquire, export the baseline, release. */
const coldRun = (
  docker: ReturnType<typeof mockLegacyDockerDaemonCliSpawner>,
  input: LegacyShadowSetupInput<never>,
  opts: LegacyShadowCacheOpts = {},
) =>
  Effect.gen(function* () {
    const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input, opts);
    yield* handle.snapshotBaseline;
    yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
    return handle;
  });

describe("legacyAcquireShadowDatabase", () => {
  it.live("is today's bare create when the cache is explicitly disabled", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "0",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);

        // `--rm` intact, no PGDATA copies either way, and the snapshot step is a no-op. The one
        // `cp-secret` is the pgsodium root key every shadow has always been given.
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.steps()).toEqual(["create", "cp-secret", "start"]);
        // Nothing is written to disk at all.
        expect(yield* soleTarName(fs, path)).toEqual([]);

        yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
        expect(docker.calls("rm")[0]).toEqual(["rm", "-f", "-v", handle.containerId]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("bypassCache acquires an uncached shadow even when a warm tar exists", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        // A published tar for this exact key — `sync --no-cache`'s bypass must ignore it.
        yield* coldRun(docker, input);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          bypassCache: true,
        });
        expect(handle.baselinePresent).toBe(false);
        // No restore in, no export out: the bypassed run neither reads nor rewrites the tar.
        const bypassSteps = docker.steps().slice(docker.steps().lastIndexOf("create"));
        expect(bypassSteps).toEqual(["create", "cp-secret", "start"]);
        expect(docker.calls("create").at(-1) ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.stepCalls("cp-out")).toHaveLength(1); // the initial cold run's only
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("stays uncached on PG14, whose setup mutates role defaults mid-session", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // PG<=14's globals SQL runs `ALTER ROLE … SET …` on the setup session; a snapshot
        // boundary would force migrations onto a fresh session that observes those defaults,
        // unlike Go's single-connection flow — so the cache must stand down entirely.
        const base = shadowInput(fs, path);
        const input = {
          ...base,
          db: { ...base.db, major_version: 14 },
          setup: { ...base.setup, majorVersion: 14 },
        };
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        expect(handle.snapshotRequired).toBe(false);
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a warm hit also sweeps abandoned partials left by a killed concurrent writer", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        // A concurrent writer SIGKILLed mid-export: its partial is older than 5 minutes.
        const abandoned = path.join(
          shadowCacheDir(path),
          "shadow-baseline-0011223344556677.tar.4242.partial",
        );
        yield* fs.writeFileString(abandoned, "stale");
        const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
        yield* fs.utimes(abandoned, sixMinutesAgo, sixMinutesAgo);

        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(warm.baselinePresent).toBe(true);
        expect(yield* fs.exists(abandoned)).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("stays uncached for an OrioleDB cluster even with the cache enabled", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // OrioleDB runs the shadow with an external S3 storage backend, so a disk-level PGDATA
        // tar is not a coherent snapshot — the acquire must degrade to the bare uncached shadow.
        const input = {
          ...shadowInput(fs, path),
          experimental: { ...defaultConfig.experimental, orioledb_version: "15" },
        };
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.calls("stop")).toEqual([]);
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("caches by default when the env var is unset (default ON)", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      undefined,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        // First acquire is a cold cache-enabled provision (no `--rm`: the export must be able
        // to stop and restart the container), and its snapshot step publishes the tar.
        const cold = yield* coldRun(docker, input);
        expect(cold.baselinePresent).toBe(false);
        expect(cold.snapshotRequired).toBe(true);
        expect(docker.calls("create")[0] ?? []).not.toContain("--rm");
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        // The next acquire — still with the env var unset — is a warm restore.
        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(warm.baselinePresent).toBe(true);
        yield* legacyRemoveShadowDatabase(docker.spawner, warm.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "an unusable cache root degrades to the uncached shadow, not a doomed cold export",
    () => {
      const docker = mockLegacyDockerDaemonCliSpawner();
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // A regular FILE occupies the cache root's path, so its mkdir can never succeed — the
          // same terminal shape as an unwritable or root-squashed `SUPABASE_HOME`. Committing to
          // the cached lifecycle anyway would drop `--rm` and pay a stop → failed export → restart
          // cycle on every invocation, so the acquire must degrade to the plain uncached shadow.
          const cacheDir = shadowCacheDir(path);
          yield* fs.makeDirectory(path.dirname(cacheDir), { recursive: true });
          yield* fs.writeFileString(cacheDir, "not a directory");

          const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
          expect(handle.baselinePresent).toBe(false);
          expect(handle.snapshotRequired).toBe(false);
          expect(docker.calls("create")[0] ?? []).toContain("--rm");
          yield* handle.snapshotBaseline;
          expect(docker.calls("stop")).toEqual([]);
          expect(out.stderrText).toContain("shadow baseline cache unavailable");
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a pre-existing read-only cache root also degrades to the uncached shadow", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Recursive mkdir on an EXISTING directory creates nothing and succeeds regardless of
        // permission, so the acquire's probe must check write access explicitly — otherwise a
        // read-only root selects the doomed cold cycle on every default-ON invocation.
        const cacheDir = shadowCacheDir(path);
        yield* fs.makeDirectory(cacheDir, { recursive: true });
        chmodSync(cacheDir, 0o500);
        // chmod cannot revoke write access from a privileged user (root ignores permission
        // bits), so mirror the workers-push suite's guard: assert the degrade only when the
        // denial is real for the CURRENT user; otherwise the cached path proceeding is correct.
        const writable = (() => {
          try {
            accessSync(cacheDir, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })();

        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
        if (writable) {
          expect(handle.snapshotRequired).toBe(true);
        } else {
          expect(handle.baselinePresent).toBe(false);
          expect(handle.snapshotRequired).toBe(false);
          expect(docker.calls("create")[0] ?? []).toContain("--rm");
          expect(out.stderrText).toContain("shadow baseline cache unavailable");
        }
        chmodSync(cacheDir, 0o700);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a project dotenv opt-out (SUPABASE_SHADOW_CACHE=0) disables the default", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      undefined,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = shadowInput(fs, path);
        const input = {
          ...base,
          setup: { ...base.setup, projectEnvValues: { SUPABASE_SHADOW_CACHE: "0" } },
        };
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("cold run stops, exports the tar, and starts the container again", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        // The cold container must survive its own `docker stop`, so it carries no `--rm`.
        expect(docker.calls("create")[0] ?? []).not.toContain("--rm");

        yield* handle.snapshotBaseline;

        // Ordering IS the contract here: stop before the copy (a live PGDATA is not coherent to
        // copy), the baseline marker stamped in between (it must be the LAST thing written to
        // PGDATA, so nothing after the platform baseline can be missing from what it vouches
        // for), start plus a readiness probe after it (the caller is about to reconnect).
        expect(docker.steps()).toEqual([
          "create",
          "cp-secret",
          "start",
          "stop",
          "cp-stamp",
          "cp-out",
          "start",
          "inspect",
        ]);
        expect(docker.stepCalls("cp-stamp")[0]).toEqual([
          "cp",
          "-",
          `${handle.containerId}:${LEGACY_PGDATA_PATH}`,
        ]);
        // The stamp really carries the marker file, delivered as a tar so `docker cp` unpacks it
        // relative to PGDATA rather than rewriting the directory's ownership — and its content is
        // this run's own cache key, which is what binds the artifact to the name it is filed under.
        const stamp = docker.containers.get(handle.containerId)?.stamp ?? "";
        expect(stamp).toContain(LEGACY_PGDATA_BASELINE_MARKER_NAME);
        expect(stamp).toContain(legacyPgDataBaselineMarkerContent(handle.snapshotKey ?? ""));
        expect(docker.stepCalls("cp-out")[0]).toEqual([
          "cp",
          `${handle.containerId}:${LEGACY_PGDATA_PATH}`,
          "-",
        ]);
        expect(docker.containers.get(handle.containerId)?.running).toBe(true);

        // Exactly one tar, published under its final name with the exported bytes intact — no
        // `.partial` left behind.
        const tars = yield* soleTarName(fs, path);
        expect(tars).toHaveLength(1);
        expect(tars[0]).toMatch(/^shadow-baseline-[0-9a-f]{16}\.tar$/u);
        const published = yield* fs.readFileString(path.join(shadowCacheDir(path), tars[0] ?? ""));
        expect(published).toBe(expectedTarFor(tars[0] ?? ""));
        expect(keyOf(tars[0] ?? "")).toBe(handle.snapshotKey);
        // The stamp made it all the way into the artifact — this is the entry the next run's
        // pre-restore scan requires, so a cold export that skipped it would never warm anything.
        expect(published).toContain(LEGACY_PGDATA_BASELINE_MARKER_ENTRY);
        const leftovers = yield* fs.readDirectory(shadowCacheDir(path));
        expect(leftovers.filter((entry) => entry.includes("partial"))).toEqual([]);

        // Release is the uncached removal, same as ever — nothing is kept.
        yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
        expect(docker.ids()).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("warm run restores the tar into a FRESH container before starting it", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const cold = yield* coldRun(docker, input);

        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        // A brand new container every time — the cache keeps a file, never a container.
        expect(warm.containerId).not.toBe(cold.containerId);
        expect(warm.baselinePresent).toBe(true);
        // Throwaway again: the warm container never gets stopped, so `--rm` is back.
        expect(docker.calls("create").at(-1) ?? []).toContain("--rm");

        // The restore lands BEFORE the start, and carries the exported bytes into PGDATA's parent.
        const warmSteps = docker.steps().slice(docker.steps().lastIndexOf("create"));
        expect(warmSteps).toEqual(["create", "cp-secret", "cp-in", "start", "inspect"]);
        expect(docker.stepCalls("cp-in").at(-1)).toEqual([
          "cp",
          "-",
          `${warm.containerId}:${LEGACY_PGDATA_PARENT_PATH}`,
        ]);
        const [warmTarName = ""] = yield* soleTarName(fs, path);
        expect(docker.containers.get(warm.containerId)?.restored).toBe(
          `${LEGACY_PGDATA_PARENT_PATH}::${expectedTarFor(warmTarName)}`,
        );

        // Nothing more is exported: the baseline is already on disk.
        yield* warm.snapshotBaseline;
        expect(docker.calls("stop")).toHaveLength(1);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a pre-created permissive temp file cannot leak into the published tar's mode", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const tempDir = shadowCacheDir(path);
        yield* fs.makeDirectory(tempDir, { recursive: true });
        // An adversarially (or crash-) pre-created temp file at THIS process's own temp path,
        // world-readable. The export must not inherit its mode: the pre-remove + `wx`
        // exclusive-create guarantees a fresh 0600 inode.
        yield* coldRun(docker, input); // publish once to learn the tar name
        const [tarName = ""] = yield* soleTarName(fs, path);
        const tarPath = path.join(tempDir, tarName);
        const tempPath = `${tarPath}.${process.pid}.partial`;
        yield* fs.remove(tarPath); // force the next run cold
        yield* fs.writeFileString(tempPath, "poisoned");
        yield* fs.chmod(tempPath, 0o666);

        yield* coldRun(docker, input);

        const info = yield* fs.stat(tarPath);
        // 0o600 exactly — not the pre-created file's 0o666.
        expect((Number(info.mode) & 0o777).toString(8)).toBe("600");
        expect(yield* fs.readFileString(tarPath)).toBe(expectedTarFor(tarName));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a cold export sweeps abandoned partial temp files but never fresh ones", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = shadowCacheDir(path);
        yield* fs.makeDirectory(tempDir, { recursive: true });
        // A SIGKILLed export leftover (older than 5 minutes) and a live writer's fresh temp file.
        const abandoned = path.join(tempDir, "shadow-baseline-0123456789abcdef.tar.99999.partial");
        const live = path.join(tempDir, "shadow-baseline-fedcba9876543210.tar.88888.partial");
        yield* fs.writeFileString(abandoned, "stale");
        yield* fs.writeFileString(live, "in-flight");
        const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
        yield* fs.utimes(abandoned, sixMinutesAgo, sixMinutesAgo);

        yield* coldRun(docker, shadowInput(fs, path));

        expect(yield* fs.exists(abandoned)).toBe(false);
        expect(yield* fs.exists(live)).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("publishing distinct keys keeps both tars until LRU/TTL eviction", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* coldRun(docker, shadowInput(fs, path));
        const first = yield* soleTarName(fs, path);
        expect(first).toHaveLength(1);

        // A changed baked-in input (jwt expiry) is a different cluster / different key — both
        // must coexist in the global cache (unlike the old project-local current-key-only sweep,
        // which would have deleted the first). Host publish port is NOT a key input.
        const rekeyed = yield* coldRun(docker, shadowInput(fs, path, { jwtExpiry: 7200 }));
        const both = yield* soleTarName(fs, path);
        expect(both).toHaveLength(2);
        expect(both).toContain(first[0]);
        expect(rekeyed.baselinePresent).toBe(false);

        // An unrelated file in the cache directory is untouched by retention.
        const stray = path.join(shadowCacheDir(path), "catalog-abc.json");
        yield* fs.writeFileString(stray, "{}");

        // mtime is the LRU ordinal, and the rapid-fire publishes below can land within the
        // filesystem's timestamp granularity — an mtime tie makes "oldest" ambiguous and the
        // eviction pick arbitrary (observed as a CI-only failure). Age the first tar explicitly:
        // this test asserts the keep-cap behavior, not tie-breaking.
        const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        yield* fs.utimes(path.join(shadowCacheDir(path), first[0] ?? ""), anHourAgo, anHourAgo);

        // Fill past keep-cap. The current key is retained, so siblings evict first.
        for (let i = 0; i < LEGACY_SHADOW_BASELINE_KEEP; i++) {
          yield* coldRun(docker, shadowInput(fs, path, { jwtExpiry: 8000 + i }));
        }
        const afterCap = yield* soleTarName(fs, path);
        expect(afterCap).toHaveLength(LEGACY_SHADOW_BASELINE_KEEP + 1);
        expect(afterCap).not.toContain(first[0]);
        expect(yield* fs.exists(stray)).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("worktrees with identical settings share a warm hit from the global cache", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktreeA = path.join(tempRoot.current, "worktree-a");
        const worktreeB = path.join(tempRoot.current, "worktree-b");
        yield* fs.makeDirectory(path.join(worktreeA, "supabase"), { recursive: true });
        yield* fs.makeDirectory(path.join(worktreeB, "supabase"), { recursive: true });

        const cold = yield* coldRun(docker, { ...shadowInput(fs, path), workdir: worktreeA });
        expect(cold.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        // Same settings, different project path — the second worktree must restore, not re-export.
        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, {
          ...shadowInput(fs, path),
          workdir: worktreeB,
        });
        expect(warm.baselinePresent).toBe(true);
        expect(warm.containerId).not.toBe(cold.containerId);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
        yield* legacyRemoveShadowDatabase(docker.spawner, warm.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a changed published host port is still a warm hit", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cold = yield* coldRun(docker, shadowInput(fs, path, { shadowPort: 54320 }));
        expect(cold.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        // pg-delta next allocates an ephemeral host port per shadow; the published port is
        // not in PGDATA, so a later run on a different port must restore the same tar.
        const warm = yield* legacyAcquireShadowDatabase(
          docker.spawner,
          shadowInput(fs, path, { shadowPort: 54399 }),
        );
        expect(warm.baselinePresent).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
        yield* legacyRemoveShadowDatabase(docker.spawner, warm.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("legacy forced-on webhooks and next config-following webhooks do not share a tar", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        // `shadowSetup.webhooksEnabled` is false, so `"config"` (next migrate) and
        // `"disabled"` (next declarative) bake the same cluster; `"enabled"` (legacy
        // migrate) does not and must not restore that tar.
        yield* coldRun(docker, input, { webhooks: "config" });
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        const forcedOn = yield* coldRun(docker, input, { webhooks: "enabled" });
        expect(forcedOn.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(2);

        const warmConfig = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          webhooks: "config",
        });
        expect(warmConfig.baselinePresent).toBe(true);
        const warmDisabled = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          webhooks: "disabled",
        });
        expect(warmDisabled.baselinePresent).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(2);
        yield* legacyRemoveShadowDatabase(docker.spawner, warmConfig.containerId);
        yield* legacyRemoveShadowDatabase(docker.spawner, warmDisabled.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a changed internal image registry is a different key, not a warm hit", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        const defaultRegistryTar = yield* soleTarName(fs, path);
        expect(defaultRegistryTar).toHaveLength(1);

        // The one-shot migrate jobs resolve their images through
        // `SUPABASE_INTERNAL_IMAGE_REGISTRY`, so a different registry can bake different
        // realtime/storage/auth schema under identical tags — the snapshot must not be shared.
        const mirrored = yield* legacyWithEnv(
          "SUPABASE_INTERNAL_IMAGE_REGISTRY",
          "mirror.internal.example",
          coldRun(docker, input),
        );
        expect(mirrored.baselinePresent).toBe(false);
        const mirroredTar = yield* soleTarName(fs, path);
        // Distinct keys coexist in the global cache — the default-registry tar is not swept.
        expect(mirroredTar).toHaveLength(2);
        expect(mirroredTar).toContain(defaultRegistryTar[0]);
        expect(mirroredTar.some((name) => name !== defaultRegistryTar[0])).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "a shadow that cannot come back after the snapshot fails the run, not just the cache",
    () => {
      const docker = mockLegacyDockerDaemonCliSpawner({ failRestart: true });
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
          // The export itself succeeds (stop + copy-out are fine); the revive `docker start` fails.
          // Reporting success here would send the caller's next connect to a dead container's port
          // — possibly answered by a DIFFERENT Postgres by then — so this must be a failure, not a
          // "not cached" warning.
          const exit = yield* handle.snapshotBaseline.pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(out.stderrText).not.toContain("Warning: shadow baseline not cached");
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a failed export warns, leaves no tar, and still brings the container back up", () => {
    const docker = mockLegacyDockerDaemonCliSpawner({ failCopyOut: true });
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
        // The run itself must never fail for a cache problem.
        yield* handle.snapshotBaseline;

        expect(out.stderrText).toContain("Warning: shadow baseline not cached");
        // The caller is about to reconnect, so the container is running again regardless.
        expect(docker.containers.get(handle.containerId)?.running).toBe(true);
        // Neither a published tar nor a half-written temp file survives.
        const entries = yield* fs.readDirectory(shadowCacheDir(path));
        expect(entries).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "a failed warm restore falls back cold, keeping the tar until its export replaces it",
    () => {
      const docker = mockLegacyDockerDaemonCliSpawner({ failCopyIn: true });
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const input = shadowInput(fs, path);
          // A cold run first, so a snapshot for this exact key exists to be restored.
          const cold = yield* coldRun(docker, input);
          expect(yield* soleTarName(fs, path)).toHaveLength(1);

          const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input);
          expect(out.stderrText).toContain("cached shadow baseline unusable");
          // Falls all the way back to a cold provision — a fresh container with no baseline.
          expect(fallback.baselinePresent).toBe(false);
          expect(fallback.containerId).not.toBe(cold.containerId);
          // The container whose restore failed is removed, not orphaned: with the cold run's own
          // container already released by `coldRun`, only the fallback's remains.
          expect(docker.ids()).toEqual([fallback.containerId]);
          // An extraction failure does NOT implicate the tar's contents (it could just as well be
          // a daemon hiccup), so the tar survives the fallback decision...
          expect(yield* soleTarName(fs, path)).toHaveLength(1);
          // ...and the cold fallback's own export atomically republishes over it, so a genuinely
          // corrupt tar still self-heals within this one run.
          yield* fallback.snapshotBaseline;
          expect(yield* soleTarName(fs, path)).toHaveLength(1);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a published tar carrying no cluster is discarded instead of restored", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        const [tarName = ""] = yield* soleTarName(fs, path);
        const tarPath = path.join(shadowCacheDir(path), tarName);

        // The published artifact is replaced by a tar that is perfectly well-formed but carries no
        // PGDATA: `docker cp -` would extract nothing, the entrypoint would `initdb` a fresh
        // cluster, readiness would pass, and the caller would diff against a BARE database while
        // being told the platform baseline was present.
        yield* fs.writeFileString(tarPath, LEGACY_FAKE_EMPTY_TAR);
        const stepsBefore = docker.steps().length;

        const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input);

        expect(out.stderrText).toContain("cached shadow baseline unusable");
        expect(out.stderrText).toContain("data/PG_VERSION");
        expect(fallback.baselinePresent).toBe(false);
        // Caught before any container was created, so nothing was ever restored.
        expect(docker.steps().slice(stepsBefore)).not.toContain("cp-in");
        // The contents ARE the problem, so the tar goes — and the cold fallback republishes a
        // good one within the same run, which is what keeps this fail-open.
        expect(yield* soleTarName(fs, path)).toEqual([]);
        yield* fallback.snapshotBaseline;
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
        expect(yield* fs.readFileString(tarPath)).toBe(expectedTarFor(tarName));
        yield* legacyRemoveShadowDatabase(docker.spawner, fallback.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a published tar carrying a bare cluster is discarded instead of restored", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        const [tarName = ""] = yield* soleTarName(fs, path);
        const tarPath = path.join(shadowCacheDir(path), tarName);

        // A REAL, perfectly restorable PGDATA — but one that never ran the platform baseline. This
        // is the failure `data/PG_VERSION` alone cannot see: `docker cp -` extracts a genuine
        // cluster, the entrypoint SKIPS `initdb`, readiness passes, and the caller would be told
        // the baseline is present while diffing against a bare database. Only the missing marker
        // separates it from a usable snapshot.
        yield* fs.writeFileString(tarPath, LEGACY_FAKE_UNSTAMPED_PGDATA_TAR);
        const stepsBefore = docker.steps().length;

        const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input);

        expect(out.stderrText).toContain("cached shadow baseline unusable");
        expect(out.stderrText).toContain(LEGACY_PGDATA_BASELINE_MARKER_ENTRY);
        expect(fallback.baselinePresent).toBe(false);
        // Caught before any container was created, so nothing was ever restored.
        expect(docker.steps().slice(stepsBefore)).not.toContain("cp-in");
        // The contents ARE the problem, so the tar goes — and the cold fallback republishes a
        // marked one within the same run.
        expect(yield* soleTarName(fs, path)).toEqual([]);
        yield* fallback.snapshotBaseline;
        expect(yield* fs.readFileString(tarPath)).toBe(expectedTarFor(tarName));
        yield* legacyRemoveShadowDatabase(docker.spawner, fallback.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "another key's snapshot copied over this key's filename is discarded, not restored",
    () => {
      const docker = mockLegacyDockerDaemonCliSpawner();
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const inputA = shadowInput(fs, path, { jwtExpiry: 3600 });
          const inputB = shadowInput(fs, path, { jwtExpiry: 7200 });
          // Two genuinely different configurations, each with its own published snapshot.
          const coldA = yield* coldRun(docker, inputA);
          const coldB = yield* coldRun(docker, inputB);
          const keyA = coldA.snapshotKey ?? "";
          const keyB = coldB.snapshotKey ?? "";
          expect(keyA).not.toBe(keyB);
          const tarPathB = path.join(shadowCacheDir(path), `shadow-baseline-${keyB}.tar`);
          const tarPathA = path.join(shadowCacheDir(path), `shadow-baseline-${keyA}.tar`);

          // A's snapshot copied over B's cache file — the shape a copied `~/.supabase/cache`
          // directory, a restored backup, or a hand-renamed tar produces. Every entry the
          // presence check requires is there (it IS a real, fully baselined cluster), so only the
          // marker's key separates it from B's own baseline: restoring it would silently diff
          // against A's roles, vault values and service schema.
          yield* fs.writeFileString(tarPathB, yield* fs.readFileString(tarPathA));
          const stepsBefore = docker.steps().length;

          const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, inputB);

          expect(out.stderrText).toContain("cached shadow baseline unusable");
          expect(out.stderrText).toContain(`snapshot is stamped with key ${keyA}, not ${keyB}`);
          expect(fallback.baselinePresent).toBe(false);
          // Caught before any container was created, so nothing was ever restored.
          expect(docker.steps().slice(stepsBefore)).not.toContain("cp-in");
          // Only the MISNAMED COPY goes: nothing else can ever be filed under B's name, while A's
          // own tar — still correctly named — is left completely alone.
          expect(yield* fs.exists(tarPathB)).toBe(false);
          expect(yield* fs.readFileString(tarPathA)).toBe(
            expectedTarFor(`shadow-baseline-${keyA}.tar`),
          );
          // ...and the cold fallback republishes B's real baseline within the same run.
          yield* fallback.snapshotBaseline;
          expect(yield* fs.readFileString(tarPathB)).toBe(
            expectedTarFor(`shadow-baseline-${keyB}.tar`),
          );
          yield* legacyRemoveShadowDatabase(docker.spawner, fallback.containerId);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a failed baseline stamp leaves the run uncached rather than publishing a tar", () => {
    const docker = mockLegacyDockerDaemonCliSpawner({ failStamp: true });
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
        // Same fail-open contract as every other export failure: the run itself never fails...
        yield* handle.snapshotBaseline;

        expect(out.stderrText).toContain("Warning: shadow baseline not cached");
        expect(out.stderrText).toContain(LEGACY_PGDATA_BASELINE_MARKER_ENTRY);
        // ...the shadow is back up for the caller to reconnect to...
        expect(docker.containers.get(handle.containerId)?.running).toBe(true);
        // ...and nothing is published, because an UNMARKED tar would only be thrown away on the
        // next run anyway. The export never even runs.
        expect(docker.stepCalls("cp-out")).toHaveLength(0);
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a restored shadow that never becomes ready is removed before the cold retry", () => {
    const docker = mockLegacyDockerDaemonCliSpawner();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const healthy = fakeCluster();
        const cold = yield* coldRun(docker, input).pipe(Effect.provide(healthy.layer));
        const tarBefore = yield* soleTarName(fs, path);
        expect(tarBefore).toHaveLength(1);

        // The restored cluster refuses every connection — the restore produced something
        // unstartable, so the tar itself is suspect.
        const broken = fakeCluster({ failConnect: true });
        const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input).pipe(
          Effect.provide(broken.layer),
        );

        expect(fallback.baselinePresent).toBe(false);
        expect(fallback.containerId).not.toBe(cold.containerId);
        // The suspect container is gone before the replacement is created — it holds the shadow's
        // published port.
        const removeIndex = docker.spawned.findIndex((args) => args[0] === "rm");
        const recreateIndex = docker.spawned.findLastIndex((args) => args[0] === "create");
        expect(removeIndex).toBeGreaterThanOrEqual(0);
        expect(removeIndex).toBeLessThan(recreateIndex);
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, fakeCluster().layer)));
  });
});
