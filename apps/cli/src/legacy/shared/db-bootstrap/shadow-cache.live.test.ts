/**
 * The shadow baseline cache's ONE live scenario (golden path only, per the repo's live-test
 * policy): against a real Docker daemon and a real `supabase/postgres` container, a cold acquire +
 * export must leave a tar that the next acquire restores into a BRAND NEW container which comes up
 * pristine — the facts no mock can prove, since they depend on `docker cp`'s tar stream actually
 * preserving PGDATA's ownership, on `docker-entrypoint.sh` actually skipping `initdb` when it finds
 * a restored data directory, and on Postgres actually starting on a data directory copied out of a
 * stopped container.
 *
 * Gated with `describeDockerLive` (the cli-e2e-ci signal composed with a `docker info` probe, since
 * this is a Docker-only local-stack suite). This is deliberately NOT a `runSupabaseLive` subprocess
 * test: the contract under test is the acquire pair itself, and driving it directly avoids standing
 * up a full local stack for `db diff` just to observe a container's cluster.
 *
 * The platform baseline itself is out of scope here (its one-shot migrate jobs are exercised by the
 * `db diff`/`db pull` suites): the cache snapshots whatever PGDATA contains at the snapshot point,
 * so a bare cluster is a faithful stand-in for it.
 */

import { join } from "node:path";
import * as net from "node:net";

import type { ProjectConfig } from "@supabase/config";
import { ProjectConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { describeDockerLive } from "../../../../tests/helpers/live.ts";
import { legacyWithEnv } from "../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { containerCliExitCode } from "../legacy-container-cli.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { legacyDbConnectionLayer } from "../legacy-db-connection.layer.ts";
import { legacyShadowBaselineCacheDir } from "../legacy-pgdelta.paths.ts";
import { legacyWaitForShadowReady } from "./health-check.ts";
import {
  LEGACY_SHADOW_CACHE_ENV,
  legacyAcquireShadowDatabase,
  legacyShadowBaselineTarFileName,
  legacyShadowCacheEnabled,
} from "./shadow-cache.ts";
import { legacyRemoveShadowDatabase } from "./shadow-database.ts";
import type { LegacyShadowDbSetupInput, LegacyShadowSetupInput } from "./shadow-database.ts";

const defaultConfig: ProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema)({});

const SHADOW_CACHE_LIVE_NETWORK_ID = "supabase_network_shadow_cache_live";

/**
 * Binds an ephemeral port and releases it immediately, mirroring
 * `legacy-db-connection.sql-pg.integration.test.ts`'s `acquireClosedPort` idiom: a fixed port
 * would collide with a concurrent live file (or a stray local process) holding it, so each run
 * claims a free one from the OS instead.
 */
const acquireEphemeralPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

describeDockerLive("shadow baseline cache (live Docker)", () => {
  it.live(
    "restores a fresh container from the exported snapshot, without the previous run's changes",
    () => {
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-shadow-cache-live-" });
        const supabaseHome = yield* fs.makeTempDirectoryScoped({
          prefix: "legacy-shadow-cache-home-",
        });
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        const shadowPort = yield* Effect.promise(() => acquireEphemeralPort());

        const setup: LegacyShadowDbSetupInput<never> = {
          majorVersion: 17,
          config: defaultConfig,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${shadowPort}/postgres`,
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
        };
        const input: LegacyShadowSetupInput<never> = {
          db: { major_version: 17, settings: {} },
          experimental: defaultConfig.experimental,
          jwtSecret: setup.jwtSecret,
          jwtExpiry: 3600,
          networkId: SHADOW_CACHE_LIVE_NETWORK_ID,
          image: dockerfileServiceImage("postgres"),
          configImage: dockerfileServiceImage("postgres"),
          shadowPort,
          password: "postgres",
          projectId: "shadow_cache_live",
          isBitbucketPipeline: false,
          workdir,
          extraHosts: [],
          fs,
          path,
          hostname: "127.0.0.1",
          healthTimeoutSeconds: 60,
          setup,
        };
        const connConfig = {
          host: input.hostname,
          port: input.shadowPort,
          user: "postgres",
          password: input.password,
          database: "postgres",
        };

        // Owned by this run's `legacyEnsureNetwork` call inside `legacyAcquireShadowDatabase`:
        // registered before either container's own finalizer below, so it removes the network
        // LAST (finalizers run LIFO), after both containers have already been torn down.
        yield* Effect.addFinalizer(() =>
          containerCliExitCode(spawner, ["network", "rm", SHADOW_CACHE_LIVE_NETWORK_ID], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }).pipe(Effect.ignore),
        );

        yield* legacyWithEnv(
          "SUPABASE_HOME",
          supabaseHome,
          legacyWithEnv(
            LEGACY_SHADOW_CACHE_ENV,
            "1",
            Effect.gen(function* () {
              expect(legacyShadowCacheEnabled()).toBe(true);
              const connection = yield* LegacyDbConnection;

              // --- Run 1: cold provision, export the pristine cluster, then dirty it. ---
              const cold = yield* legacyAcquireShadowDatabase(spawner, input);
              yield* Effect.addFinalizer(() =>
                legacyRemoveShadowDatabase(spawner, cold.containerId).pipe(Effect.ignore),
              );
              expect(cold.baselinePresent).toBe(false);
              yield* legacyWaitForShadowReady(spawner, cold.containerId, connConfig, {
                timeoutSeconds: input.healthTimeoutSeconds,
              });
              // The export stops and restarts the container, so nothing may be connected while it
              // runs — exactly the contract `legacyMigrateShadowDatabase` honours around this same
              // step.
              yield* cold.snapshotBaseline;
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* connection.connect(connConfig, {
                    isLocal: true,
                    dnsResolver: "native",
                  });
                  // Whatever a real run's migrations would do: a cluster-global role plus a
                  // database object, neither of which may survive into the next run.
                  yield* session.exec("CREATE ROLE shadow_cache_live_role");
                  yield* session.exec("CREATE TABLE shadow_cache_live_table ()");
                }),
              );
              yield* legacyRemoveShadowDatabase(spawner, cold.containerId);

              // --- Run 2: the same key restores that snapshot into a NEW container, pristine. ---
              const warm = yield* legacyAcquireShadowDatabase(spawner, input);
              yield* Effect.addFinalizer(() =>
                legacyRemoveShadowDatabase(spawner, warm.containerId).pipe(Effect.ignore),
              );
              // The cache keeps a file, never a container: run 2 is a brand new container that
              // skipped the baseline because its PGDATA arrived pre-initialized.
              expect(warm.containerId).not.toBe(cold.containerId);
              expect(warm.baselinePresent).toBe(true);
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* connection.connect(connConfig, {
                    isLocal: true,
                    dnsResolver: "native",
                  });
                  const roles = yield* session.query(
                    "SELECT rolname FROM pg_roles WHERE rolname = 'shadow_cache_live_role'",
                  );
                  expect(roles).toEqual([]);
                  const tables = yield* session.query(
                    "SELECT tablename FROM pg_tables WHERE tablename = 'shadow_cache_live_table'",
                  );
                  expect(tables).toEqual([]);
                  // Restored, not re-initialized: the baseline cluster's own roles are all still
                  // there.
                  const postgres = yield* session.query(
                    "SELECT rolname FROM pg_roles WHERE rolname = 'postgres'",
                  );
                  expect(postgres).toHaveLength(1);
                }),
              );
              yield* legacyRemoveShadowDatabase(spawner, warm.containerId);

              // The artifact is a plain file under the global per-settings cache — the property
              // that lets worktrees with the same settings share a warm hit, and a future native
              // (non-Docker) Postgres service consume the same snapshot.
              const tempDir = legacyShadowBaselineCacheDir(path);
              const entries = yield* fs.readDirectory(tempDir);
              const tars = entries.filter((entry) => entry.endsWith(".tar"));
              expect(tars).toHaveLength(1);
              expect(tars[0]).toMatch(/^shadow-baseline-[0-9a-f]{16}\.tar$/u);
              expect(tempDir).toBe(join(supabaseHome, "cache", "shadow-baseline"));
              expect(legacyShadowBaselineTarFileName("0".repeat(16))).toBe(
                `shadow-baseline-${"0".repeat(16)}.tar`,
              );
            }),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, legacyDbConnectionLayer)),
      );
    },
    300_000,
  );
});
