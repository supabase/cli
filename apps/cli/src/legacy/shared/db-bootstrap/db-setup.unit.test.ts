import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@supabase/config";
import { ProjectConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Path, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { LegacyDbExecError } from "../legacy-db-connection.errors.ts";
import { LegacyDbConnection, type LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "../legacy-docker-run.service.ts";
import { LegacyDockerRunError } from "../legacy-docker-run.errors.ts";
import { LegacyEdgeRuntimeScriptError } from "../legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  type LegacyEdgeRuntimeRunOpts,
} from "../legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../legacy-pgdelta-ssl-probe.service.ts";
import {
  LegacyDbSetupError,
  legacyResolveDbSetupPrelude,
  legacyRunDatabaseWebhooksSetup,
  legacyStartInitCurrentBranch,
  legacyStartSetupLocalDatabase,
  type LegacyStartSetupLocalDatabaseInput,
} from "./db-setup.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

/**
 * Fingerprints unique to each transcribed SQL constant — see `db-setup.ts`'s
 * templates. No trailing `;`: `legacySplitAndTrim` strips it from every
 * executed statement before `session.exec` sees it.
 *
 * `GLOBALS`/`SCHEMA_13`/`REVOKE_PRIVILEGES` are checked as SUBSTRINGS: each is
 * embedded inside a larger executed block (a preceding comment, a `DO`-style
 * conditional, or the sibling `alter default privileges` line). `SCHEMA_14`
 * is checked with `.endsWith` instead — `CREATE SCHEMA IF NOT EXISTS graphql`
 * is itself preceded by a comment block (so a plain equality check would
 * fail), but a naive substring check would also match 14.sql's unrelated
 * `CREATE SCHEMA IF NOT EXISTS graphql_public` statement, since `graphql` is
 * a prefix of `graphql_public`.
 */
const GLOBALS_FINGERPRINT = "CREATE ROLE anon";
const SCHEMA_13_FINGERPRINT =
  "CREATE USER supabase_functions_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION";
const SCHEMA_14_FINGERPRINT_SUFFIX = "CREATE SCHEMA IF NOT EXISTS graphql";
const REVOKE_PRIVILEGES_FINGERPRINT =
  "revoke execute on functions from anon, authenticated, service_role";
const PG_NET_CREATE_FINGERPRINT = "create extension if not exists pg_net schema extensions";

function fakeSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "exec", sql });
      }),
    query: (sql, params) =>
      Effect.sync(() => {
        calls.push({ kind: "query", sql, params });
        return [];
      }),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

function mockDockerRun(opts: { exitCode?: number } = {}) {
  const runs: Array<LegacyDockerRunOpts> = [];
  const captureOptsCalls: Array<{ readonly teeStderr?: boolean } | undefined> = [];
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(opts.exitCode ?? 0),
    runCapture: (runOpts, captureOpts) => {
      runs.push(runOpts);
      captureOptsCalls.push(captureOpts);
      return Effect.succeed({
        exitCode: opts.exitCode ?? 0,
        stdout: new Uint8Array(),
        stderr: "",
      });
    },
    // `legacyRunStartMigrateJob` (`db-setup.ts`) discards stdout via `runStream` (not
    // `runCapture`), matching Go's `io.Discard` writer for these one-shot jobs — this
    // suite's `docker.runs`/`captureOptsCalls` assertions track THIS method's calls, not
    // `runCapture`'s (which nothing under test still calls).
    runStream: (runOpts, streamOpts) => {
      runs.push(runOpts);
      captureOptsCalls.push({ teeStderr: streamOpts.teeStderr });
      return Effect.succeed({ exitCode: opts.exitCode ?? 0, stderr: "" });
    },
  });
  return { layer, runs, captureOptsCalls };
}

/**
 * A `ChildProcessSpawner` where `docker image inspect <image>` always exits 0 (image
 * already cached) — feeds `legacyRunStartMigrateJob`'s own per-image `legacyEnsureImagesCached`
 * resolve (see `db-setup.ts`), so every job's `image` resolves to the SAME raw string this
 * suite's `baseInput` already asserts on, without needing a real Docker daemon.
 */
function mockAlwaysCachedSpawner(): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((_command) =>
    Effect.gen(function* () {
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

function mockDockerRunFails() {
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () =>
      Effect.fail(
        new LegacyDockerRunError({
          message: "failed to run docker",
          reason: "spawn",
          daemonDown: false,
        }),
      ),
    runCapture: () =>
      Effect.fail(
        new LegacyDockerRunError({
          message: "failed to run docker",
          reason: "spawn",
          daemonDown: false,
        }),
      ),
    runStream: () =>
      Effect.fail(
        new LegacyDockerRunError({
          message: "failed to run docker",
          reason: "spawn",
          daemonDown: false,
        }),
      ),
  });
  return { layer };
}

/**
 * `LegacyEdgeRuntimeScript`/`LegacyPgDeltaSslProbe` back
 * `legacyTryCacheMigrationsCatalog`'s own pg-delta catalog-export call (`db-setup.ts`'s
 * pgcache-warmup step) — required by {@link legacyStartSetupLocalDatabase}'s own widened
 * effect environment regardless of whether a given test's config actually enables
 * pg-delta (the early `!params.enabled` return means these mocks are never invoked at
 * runtime unless a test opts in via `writeConfigToml`'s `[experimental.pgdelta]`).
 */
function mockEdgeRuntime(opts: { readonly stdout?: string; readonly failWith?: string } = {}) {
  const calls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(runOpts);
      if (opts.failWith !== undefined) {
        return Effect.fail(new LegacyEdgeRuntimeScriptError({ message: opts.failWith }));
      }
      return Effect.succeed({ stdout: opts.stdout ?? '{"version":1}', stderr: "" });
    },
  });
  return { layer, calls };
}

function mockPgDeltaSslProbeLayer() {
  return Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "legacy-db-setup-"));
}

function writeConfigToml(workdir: string, content: string): void {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), content);
}

const defaultConfig: ProjectConfig = decodeConfig({});

function baseInput(
  workdir: string,
  session: LegacyDbSession,
  overrides: Partial<LegacyStartSetupLocalDatabaseInput> = {},
): Omit<LegacyStartSetupLocalDatabaseInput, "fs" | "path"> {
  return {
    session,
    workdir,
    config: defaultConfig,
    experimental: false,
    majorVersion: 17,
    dbHost: "supabase_db_proj",
    projectId: "proj",
    networkId: "supabase_network_proj",
    dbUrl: "postgresql://postgres:postgrespassword@127.0.0.1:54322/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: '{"keys":[]}',
    apiUrl: "http://127.0.0.1:54321",
    siteUrl: defaultConfig.auth.site_url,
    anonKey: "anon-key",
    serviceRoleKey: "service-role-key",
    storageTargetMigration: "",
    images: {
      realtime: "public.ecr.aws/supabase/realtime:v2.34.7",
      storage: "public.ecr.aws/supabase/storage-api:v1.0.0",
      auth: "public.ecr.aws/supabase/gotrue:v2.170.0",
    },
    projectEnvValues: undefined,
    debug: false,
    version: "",
    seedFlags: { noSeed: false, sqlPaths: [] },
    ...overrides,
  };
}

const run = (
  input: Omit<LegacyStartSetupLocalDatabaseInput, "fs" | "path">,
  out: ReturnType<typeof mockOutput>,
  docker: ReturnType<typeof mockDockerRun> | ReturnType<typeof mockDockerRunFails>,
  edgeRuntime: ReturnType<typeof mockEdgeRuntime> = mockEdgeRuntime(),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyStartSetupLocalDatabase(mockAlwaysCachedSpawner(), {
      ...input,
      fs,
      path,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        out.layer,
        docker.layer,
        mockRuntimeInfo({ platform: "darwin" }),
        edgeRuntime.layer,
        mockPgDeltaSslProbeLayer(),
      ),
    ),
  );

describe("legacyStartSetupLocalDatabase", () => {
  describe("PG <= 14 vs PG >= 15 schema branch", () => {
    it.effect("PG14: execs globals + the PG14 initial schema, runs no one-shot docker jobs", () => {
      const workdir = makeWorkdir();
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
        Effect.map(() => {
          const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execSql.some((sql) => sql.includes(GLOBALS_FINGERPRINT))).toBe(true);
          expect(execSql.some((sql) => sql.endsWith(SCHEMA_14_FINGERPRINT_SUFFIX))).toBe(true);
          expect(execSql.some((sql) => sql.includes(SCHEMA_13_FINGERPRINT))).toBe(false);
          expect(docker.runs.length).toBe(0);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("PG13: execs globals + the PG13 initial schema, not the PG14 one", () => {
      const workdir = makeWorkdir();
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 13 }), out, docker).pipe(
        Effect.map(() => {
          const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execSql.some((sql) => sql.includes(GLOBALS_FINGERPRINT))).toBe(true);
          expect(execSql.some((sql) => sql.includes(SCHEMA_13_FINGERPRINT))).toBe(true);
          expect(execSql.some((sql) => sql.endsWith(SCHEMA_14_FINGERPRINT_SUFFIX))).toBe(false);
          expect(docker.runs.length).toBe(0);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("PG15+: runs one-shot docker jobs, execs no schema SQL at all", () => {
      const workdir = makeWorkdir();
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 17 }), out, docker).pipe(
        Effect.map(() => {
          const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execSql.some((sql) => sql.includes(GLOBALS_FINGERPRINT))).toBe(false);
          expect(execSql.some((sql) => sql.includes(SCHEMA_13_FINGERPRINT))).toBe(false);
          expect(execSql.some((sql) => sql.endsWith(SCHEMA_14_FINGERPRINT_SUFFIX))).toBe(false);
          // Default config: realtime, storage, and auth are all enabled.
          expect(docker.runs.length).toBe(3);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });
  });

  describe("PG15+ one-shot job gating", () => {
    it.effect("gates each job independently on its own service's enabled flag", () => {
      const workdir = makeWorkdir();
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const config = decodeConfig({
        realtime: { enabled: true },
        storage: { enabled: false },
        auth: { enabled: true },
      });
      return run(baseInput(workdir, session, { majorVersion: 15, config }), out, docker).pipe(
        Effect.map(() => {
          expect(docker.runs.length).toBe(2);
          const images = docker.runs.map((r) => r.image);
          expect(images).toContain("public.ecr.aws/supabase/realtime:v2.34.7");
          expect(images).toContain("public.ecr.aws/supabase/gotrue:v2.170.0");
          expect(images).not.toContain("public.ecr.aws/supabase/storage-api:v1.0.0");
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("runs nothing when all three services are disabled", () => {
      const workdir = makeWorkdir();
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const config = decodeConfig({
        realtime: { enabled: false },
        storage: { enabled: false },
        auth: { enabled: false },
      });
      return run(baseInput(workdir, session, { majorVersion: 15, config }), out, docker).pipe(
        Effect.map(() => {
          expect(docker.runs.length).toBe(0);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect(
      "labels every one-shot job with the project's Docker labels, matching Go's DockerStart (review: Codex, PR #6022)",
      () => {
        const workdir = makeWorkdir();
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        // Default config: realtime, storage, and auth are all enabled — 3 jobs.
        return run(
          baseInput(workdir, session, { majorVersion: 15, projectId: "labeled-proj" }),
          out,
          docker,
        ).pipe(
          Effect.map(() => {
            expect(docker.runs.length).toBe(3);
            for (const job of docker.runs) {
              expect(job.labels).toEqual({
                "com.supabase.cli.project": "labeled-proj",
                "com.docker.compose.project": "labeled-proj",
              });
            }
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "the realtime job's env matches `legacyBuildRealtimeEnv` on the internal db address + jwks",
      () => {
        const workdir = makeWorkdir();
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const config = decodeConfig({ storage: { enabled: false }, auth: { enabled: false } });
        return run(
          baseInput(workdir, session, {
            majorVersion: 15,
            config,
            dbHost: "supabase_db_myproj",
            jwks: '{"keys":["stub"]}',
          }),
          out,
          docker,
        ).pipe(
          Effect.map(() => {
            expect(docker.runs.length).toBe(1);
            const job = docker.runs[0]!;
            expect(job.cmd[0]).toBe("/app/bin/realtime");
            expect(job.cmd[1]).toBe("eval");
            expect(job.cmd[2]).toContain('Realtime.Tenants.health_check("realtime-dev")');
            expect(job.env["DB_HOST"]).toBe("supabase_db_myproj");
            expect(job.env["API_JWT_JWKS"]).toBe('{"keys":["stub"]}');
            expect(job.network).toEqual({ _tag: "named", name: "supabase_network_proj" });
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "the auth job's env derives API_EXTERNAL_URL from apiUrl and carries site_url + jwt secret",
      () => {
        const workdir = makeWorkdir();
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const config = decodeConfig({ realtime: { enabled: false }, storage: { enabled: false } });
        return run(
          baseInput(workdir, session, {
            majorVersion: 15,
            config,
            apiUrl: "http://127.0.0.1:54321/",
          }),
          out,
          docker,
        ).pipe(
          Effect.map(() => {
            expect(docker.runs.length).toBe(1);
            const job = docker.runs[0]!;
            expect(job.cmd).toEqual(["gotrue", "migrate"]);
            expect(job.env["API_EXTERNAL_URL"]).toBe("http://127.0.0.1:54321/auth/v1");
            expect(job.env["GOTRUE_SITE_URL"]).toBe(config.auth.site_url);
            expect(job.env["GOTRUE_JWT_SECRET"]).toBe(
              "super-secret-jwt-token-with-at-least-32-characters-long",
            );
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "the auth job's GOTRUE_SITE_URL reflects the caller's resolved siteUrl, not the raw config value",
      () => {
        // `siteUrl` is already SUPABASE_AUTH_SITE_URL-overridden by the caller
        // (`start.handler.ts`'s `values.authSiteUrl`) — the one-shot auth
        // migration job must agree with the long-running GoTrue container,
        // not fall back to reading the un-overridden `config.auth.site_url`.
        const workdir = makeWorkdir();
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const config = decodeConfig({
          realtime: { enabled: false },
          storage: { enabled: false },
          auth: { site_url: "http://raw-config-value.example" },
        });
        return run(
          baseInput(workdir, session, {
            majorVersion: 15,
            config,
            apiUrl: "http://127.0.0.1:54321/",
            siteUrl: "http://env-overridden-value.example",
          }),
          out,
          docker,
        ).pipe(
          Effect.map(() => {
            const job = docker.runs[0]!;
            expect(job.env["GOTRUE_SITE_URL"]).toBe("http://env-overridden-value.example");
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "--debug tees every one-shot job's stderr, matching Go's utils.GetDebugLogger()",
      () => {
        const workdir = makeWorkdir();
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const config = decodeConfig({
          realtime: { enabled: true },
          storage: { enabled: false },
          auth: { enabled: true },
        });
        return run(
          baseInput(workdir, session, { majorVersion: 15, config, debug: true }),
          out,
          docker,
        ).pipe(
          Effect.map(() => {
            expect(docker.runs.length).toBe(2);
            expect(docker.captureOptsCalls).toEqual([{ teeStderr: true }, { teeStderr: true }]);
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect("without --debug, one-shot jobs run with teeStderr off", () => {
      const workdir = makeWorkdir();
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const config = decodeConfig({ storage: { enabled: false }, auth: { enabled: false } });
      return run(
        baseInput(workdir, session, { majorVersion: 15, config, debug: false }),
        out,
        docker,
      ).pipe(
        Effect.map(() => {
          expect(docker.runs.length).toBe(1);
          expect(docker.captureOptsCalls).toEqual([{ teeStderr: false }]);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("a non-zero exit from a one-shot job fails the whole pipeline", () => {
      const workdir = makeWorkdir();
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun({ exitCode: 1 });
      const config = decodeConfig({ storage: { enabled: false }, auth: { enabled: false } });
      return run(baseInput(workdir, session, { majorVersion: 15, config }), out, docker).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyDbSetupError);
          expect((error as LegacyDbSetupError).message).toBe("error running container: exit 1");
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });
  });

  describe("ApplyApiPrivileges tri-state", () => {
    it.effect("auto_expose_new_tables = true is a no-op (no revoke SQL exec'd)", () => {
      const workdir = makeWorkdir();
      writeConfigToml(workdir, "[api]\nauto_expose_new_tables = true\n");
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
        Effect.map(() => {
          const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execSql.some((sql) => sql.includes(REVOKE_PRIVILEGES_FINGERPRINT))).toBe(false);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("auto_expose_new_tables = false execs the revoke SQL", () => {
      const workdir = makeWorkdir();
      writeConfigToml(workdir, "[api]\nauto_expose_new_tables = false\n");
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
        Effect.map(() => {
          const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execSql.some((sql) => sql.includes(REVOKE_PRIVILEGES_FINGERPRINT))).toBe(true);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect(
      "unset (no config.toml at all) matches the false behavior — execs the revoke SQL",
      () => {
        const workdir = makeWorkdir();
        const { session, calls } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
          Effect.map(() => {
            const execSql = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
            expect(execSql.some((sql) => sql.includes(REVOKE_PRIVILEGES_FINGERPRINT))).toBe(true);
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );
  });

  describe("vault upsert + custom-roles seed", () => {
    it.effect("upserts vault secrets before seeding supabase/roles.sql", () => {
      const workdir = makeWorkdir();
      writeConfigToml(workdir, '[db.vault]\nmy_secret = "shh"\n');
      writeFileSync(
        join(workdir, "supabase", "roles.sql"),
        "grant select on all tables in schema public to custom_role;",
      );
      const { session, calls } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
        Effect.map(() => {
          const vaultCallIndex = calls.findIndex(
            (c) => c.kind === "query" && c.sql.includes("vault.create_secret"),
          );
          const rolesCallIndex = calls.findIndex(
            (c) => c.kind === "exec" && c.sql.includes("custom_role"),
          );
          expect(vaultCallIndex).toBeGreaterThanOrEqual(0);
          expect(rolesCallIndex).toBeGreaterThanOrEqual(0);
          expect(vaultCallIndex).toBeLessThan(rolesCallIndex);
          expect(out.rawChunks.map((c) => c.text)).toContain("Seeding globals from roles.sql...\n");
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect(
      "prints the seed message even when supabase/roles.sql is absent, and does not error",
      () => {
        const workdir = makeWorkdir();
        const { session, calls } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker).pipe(
          Effect.map(() => {
            // Go's `SeedGlobals` prints before attempting the read (`pkg/migration/
            // seed.go:84-97`) — a missing roles.sql is tolerated, not skipped.
            expect(out.rawChunks.map((c) => c.text)).toContain(
              "Seeding globals from roles.sql...\n",
            );
            const rolesCallIndex = calls.findIndex(
              (c) => c.kind === "exec" && c.sql.includes("custom_role"),
            );
            expect(rolesCallIndex).toBe(-1);
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );
  });

  describe("pgcache migrations-catalog warmup (start.go:371-379)", () => {
    it.effect("does not attempt to cache the migrations catalog when pg-delta is disabled", () => {
      const workdir = makeWorkdir();
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const edgeRuntime = mockEdgeRuntime();
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker, edgeRuntime).pipe(
        Effect.map(() => {
          expect(edgeRuntime.calls).toHaveLength(0);
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("skips the legacy catalog when the default next engine is enabled", () => {
      const workdir = makeWorkdir();
      writeConfigToml(workdir, "[experimental.pgdelta]\nenabled = true\n");
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const edgeRuntime = mockEdgeRuntime({ stdout: '{"snapshot":"ok"}' });
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker, edgeRuntime).pipe(
        Effect.map(() => {
          expect(edgeRuntime.calls).toHaveLength(0);
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect("caches the migrations catalog for the legacy engine after MigrateAndSeed", () => {
      const workdir = makeWorkdir();
      writeConfigToml(workdir, "[experimental.pgdelta]\nenabled = true\n");
      writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_USE_PG_DELTA_NEXT=false\n");
      const { session } = fakeSession();
      const out = mockOutput();
      const docker = mockDockerRun();
      const edgeRuntime = mockEdgeRuntime({ stdout: '{"snapshot":"ok"}' });
      return run(baseInput(workdir, session, { majorVersion: 14 }), out, docker, edgeRuntime).pipe(
        Effect.map(() => {
          expect(edgeRuntime.calls).toHaveLength(1);
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          const tempDir = join(workdir, "supabase", ".temp", "pgdelta");
          const catalogFiles = readdirSync(tempDir).filter((name) =>
            name.startsWith("catalog-local-migrations-"),
          );
          expect(catalogFiles).toHaveLength(1);
          expect(readFileSync(join(tempDir, catalogFiles[0]!), "utf8")).toBe('{"snapshot":"ok"}');
          rmSync(workdir, { recursive: true, force: true });
        }),
      );
    });

    it.effect(
      "skips the legacy catalog when an empty shell value shadows a project .env false (godotenv parity)",
      () => {
        // godotenv.Load never replaces a shell value, including an empty one, so
        // an empty `SUPABASE_USE_PG_DELTA_NEXT` in the shell must suppress the
        // `supabase/.env` fallback below and resolve to the next implementation —
        // matching the engine-selector layer's own precedence rather than
        // `toml.envLookup`'s (which treats an empty shell value as unset).
        const prev = process.env["SUPABASE_USE_PG_DELTA_NEXT"];
        process.env["SUPABASE_USE_PG_DELTA_NEXT"] = "";
        const workdir = makeWorkdir();
        writeConfigToml(workdir, "[experimental.pgdelta]\nenabled = true\n");
        writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_USE_PG_DELTA_NEXT=false\n");
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const edgeRuntime = mockEdgeRuntime({ stdout: '{"snapshot":"ok"}' });
        return run(
          baseInput(workdir, session, { majorVersion: 14 }),
          out,
          docker,
          edgeRuntime,
        ).pipe(
          Effect.map(() => {
            expect(edgeRuntime.calls).toHaveLength(0);
            rmSync(workdir, { recursive: true, force: true });
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_USE_PG_DELTA_NEXT"];
              else process.env["SUPABASE_USE_PG_DELTA_NEXT"] = prev;
            }),
          ),
        );
      },
    );

    it.effect(
      "caches the migrations catalog when SUPABASE_EXPERIMENTAL_PG_DELTA is enabled via project .env",
      () => {
        const workdir = makeWorkdir();
        mkdirSync(join(workdir, "supabase"), { recursive: true });
        writeFileSync(
          join(workdir, "supabase", ".env"),
          "SUPABASE_EXPERIMENTAL_PG_DELTA=true\nSUPABASE_USE_PG_DELTA_NEXT=false\n",
        );
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const edgeRuntime = mockEdgeRuntime({ stdout: '{"snapshot":"ok"}' });
        return run(
          baseInput(workdir, session, { majorVersion: 14 }),
          out,
          docker,
          edgeRuntime,
        ).pipe(
          Effect.map(() => {
            expect(edgeRuntime.calls).toHaveLength(1);
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "applies PGDELTA_NPM_REGISTRY from the project .env for the catalog export, then reverts it",
      () => {
        // Go's `Config.Load` already `os.Setenv`'d the project `.env` into the process
        // (`loadNestedEnv`, config.go:788) long before `SetupLocalDatabase` runs, so a
        // PGDELTA_NPM_REGISTRY set only in supabase/.env (not the shell) reaches
        // `PgDeltaNpmRegistryOption` there. This module threads config overrides via
        // `projectEnvValues` rather than mutating `process.env` globally, so the
        // cache-warmup step must scope-apply it around just `legacyExportCatalogPgDelta`'s
        // call (`legacyPgDeltaNpmRegistryOption` reads bare `process.env`) and revert
        // afterwards — mirroring `db push`/`db pull`/`db dump`/`bootstrap`'s own use of
        // `legacyApplyProjectEnv` for the same shared pg-delta code.
        const previous = process.env["PGDELTA_NPM_REGISTRY"];
        delete process.env["PGDELTA_NPM_REGISTRY"];
        const workdir = makeWorkdir();
        writeConfigToml(workdir, "[experimental.pgdelta]\nenabled = true\n");
        mkdirSync(join(workdir, "supabase"), { recursive: true });
        writeFileSync(
          join(workdir, "supabase", ".env"),
          "PGDELTA_NPM_REGISTRY=https://registry.example.com/supabase\nSUPABASE_USE_PG_DELTA_NEXT=false\n",
        );
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const edgeRuntime = mockEdgeRuntime({ stdout: '{"snapshot":"ok"}' });
        return run(
          baseInput(workdir, session, {
            majorVersion: 14,
            projectEnvValues: { PGDELTA_NPM_REGISTRY: "https://registry.example.com/supabase" },
          }),
          out,
          docker,
          edgeRuntime,
        ).pipe(
          Effect.map(() => {
            expect(edgeRuntime.calls).toHaveLength(1);
            expect(edgeRuntime.calls[0]?.extraEnv?.["PGDELTA_NPM_REGISTRY"]).toBe(
              "https://registry.example.com/supabase",
            );
            expect(edgeRuntime.calls[0]?.extraEnv?.["NPM_CONFIG_REGISTRY"]).toBe(
              "https://registry.example.com/supabase",
            );
            // Reverted: the scope closes once the cache-warmup call completes, so it
            // never leaks into subsequent steps or other tests.
            expect(process.env["PGDELTA_NPM_REGISTRY"]).toBeUndefined();
            if (previous === undefined) delete process.env["PGDELTA_NPM_REGISTRY"];
            else process.env["PGDELTA_NPM_REGISTRY"] = previous;
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );

    it.effect(
      "warns without failing legacyStartSetupLocalDatabase when the catalog export fails",
      () => {
        const workdir = makeWorkdir();
        writeConfigToml(workdir, "[experimental.pgdelta]\nenabled = true\n");
        writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_USE_PG_DELTA_NEXT=false\n");
        const { session } = fakeSession();
        const out = mockOutput();
        const docker = mockDockerRun();
        const edgeRuntime = mockEdgeRuntime({
          failWith: "edge-runtime script produced no output",
        });
        return run(
          baseInput(workdir, session, { majorVersion: 14 }),
          out,
          docker,
          edgeRuntime,
        ).pipe(
          Effect.map(() => {
            expect(out.stderrText).toContain(
              "Warning: failed to cache migrations catalog: edge-runtime script produced no output",
            );
            rmSync(workdir, { recursive: true, force: true });
          }),
        );
      },
    );
  });
});

describe("legacyResolveDbSetupPrelude", () => {
  const run = (
    setup: {
      readonly majorVersion: number;
      readonly realtimeEnabledForSetup: boolean;
      readonly jwks: Effect.Effect<string, Error>;
    },
    out: ReturnType<typeof mockOutput>,
  ) =>
    legacyResolveDbSetupPrelude({ ...setup, serviceVersionOverrides: {} }).pipe(
      Effect.provide(out.layer),
    );

  it.effect('prints "Initialising schema..." to stderr exactly once, for either PG branch', () => {
    const out = mockOutput();
    return run(
      { majorVersion: 17, realtimeEnabledForSetup: false, jwks: Effect.succeed("") },
      out,
    ).pipe(
      Effect.map(() => {
        const banner = out.rawChunks.filter((c) => c.text === "Initialising schema...\n");
        expect(banner.length).toBe(1);
        expect(banner[0]?.stream).toBe("stderr");
      }),
    );
  });

  it.effect(
    'prints the banner BEFORE a JWKS resolution failure — matching Go\'s "initSchema" printing the banner before ever calling "initSchema15" -> "ResolveJWKS" (review: PRRT_kwDOErm0O86W6R-O)',
    () => {
      const out = mockOutput();
      return run(
        {
          majorVersion: 15,
          realtimeEnabledForSetup: true,
          jwks: Effect.fail(new Error("jwks discovery failed")),
        },
        out,
      ).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error.message).toBe("jwks discovery failed");
          const banner = out.rawChunks.filter((c) => c.text === "Initialising schema...\n");
          expect(banner.length).toBe(1);
          expect(banner[0]?.stream).toBe("stderr");
        }),
      );
    },
  );

  it.effect(
    "does not resolve JWKS on PG <= 14 even with realtime enabled — Go's initSchema never reaches initSchema15 there",
    () => {
      const out = mockOutput();
      let jwksCalled = false;
      const jwks = Effect.sync(() => {
        jwksCalled = true;
        return "unused";
      });
      return run({ majorVersion: 14, realtimeEnabledForSetup: true, jwks }, out).pipe(
        Effect.map((resolved) => {
          expect(jwksCalled).toBe(false);
          expect(resolved.jwks).toBe("");
        }),
      );
    },
  );
});

/**
 * `supabase start` on an EXISTING volume never replays migrations, so this
 * convergence is the only thing that can reconcile the volume's pg_net with the
 * current `[experimental.webhooks]` setting — in both directions, and without ever
 * dropping an extension a user's own migration created.
 */
describe("legacyRunDatabaseWebhooksSetup", () => {
  const PG_NET_DROP_FINGERPRINT = "drop extension if exists pg_net";

  function fakeWebhooksSession(opts: {
    readonly appliedStatements?: ReadonlyArray<ReadonlyArray<string> | null>;
    readonly historyUnavailable?: boolean;
  }) {
    const execSql: Array<string> = [];
    const session: LegacyDbSession = {
      exec: (sql) =>
        Effect.sync(() => {
          execSql.push(sql);
        }),
      query: (sql) =>
        sql.includes("supabase_migrations.schema_migrations")
          ? opts.historyUnavailable === true
            ? Effect.fail(
                new LegacyDbExecError({ message: 'relation "schema_migrations" does not exist' }),
              )
            : Effect.succeed(
                (opts.appliedStatements ?? []).map((statements, index) => ({
                  version: `2024010100000${index}`,
                  name: "migration",
                  statements,
                })),
              )
          : Effect.succeed([]),
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    };
    return { session, execSql };
  }

  const converge = (
    enabled: boolean,
    sessionOpts: Parameters<typeof fakeWebhooksSession>[0] = {},
  ) => {
    const { session, execSql } = fakeWebhooksSession(sessionOpts);
    const dbConnection = Layer.succeed(LegacyDbConnection, {
      connect: () => Effect.succeed(session),
    });
    return {
      execSql,
      effect: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacyRunDatabaseWebhooksSetup({
          fs,
          path,
          hostname: "127.0.0.1",
          dbPort: 54322,
          dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
          enabled,
        });
      }).pipe(Effect.provide(Layer.mergeAll(dbConnection, BunServices.layer))),
    };
  };

  it.effect("installs pg_net when Database Webhooks are enabled", () => {
    const { execSql, effect } = converge(true);
    return effect.pipe(
      Effect.map(() => {
        expect(execSql.some((sql) => sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(true);
        expect(execSql.some((sql) => sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(false);
      }),
    );
  });

  it.effect("drops pg_net when disabled and no applied migration installs it", () => {
    const { execSql, effect } = converge(false, {
      appliedStatements: [["create table public.items (id int)"]],
    });
    return effect.pipe(
      Effect.map(() => {
        expect(execSql.some((sql) => sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(true);
        expect(execSql.some((sql) => sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(false);
      }),
    );
  });

  it.effect("preserves pg_net created by an applied migration", () => {
    const { execSql, effect } = converge(false, {
      appliedStatements: [
        ["create table public.items (id int)"],
        ['CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA extensions'],
      ],
    });
    return effect.pipe(
      Effect.map(() => {
        expect(execSql.some((sql) => sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(false);
      }),
    );
  });

  it.effect.each([
    { historyValue: null, description: "NULL" },
    { historyValue: [], description: "an empty array" },
  ])(
    "preserves pg_net when an applied history row records $description for statements",
    ({ historyValue }) => {
      // Older volumes store NULL/`{}` in `schema_migrations.statements`. That is
      // incomplete evidence, not proof the migration did not install pg_net.
      const { execSql, effect } = converge(false, { appliedStatements: [historyValue] });
      return effect.pipe(
        Effect.map(() => {
          expect(execSql.some((sql) => sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(false);
        }),
      );
    },
  );

  it.effect("preserves pg_net when the migration history cannot be read", () => {
    // Erring toward not dropping: an unreadable history is treated as ownership.
    const { execSql, effect } = converge(false, { historyUnavailable: true });
    return effect.pipe(
      Effect.map(() => {
        expect(execSql.some((sql) => sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(false);
      }),
    );
  });
});

describe("legacyStartInitCurrentBranch", () => {
  it.effect('writes supabase/.branches/_current_branch = "main" when absent', () => {
    const workdir = makeWorkdir();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacyStartInitCurrentBranch(fs, path, workdir);
      const content = yield* fs.readFileString(
        join(workdir, "supabase", ".branches", "_current_branch"),
      );
      expect(content).toBe("main");
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.map(() => {
        rmSync(workdir, { recursive: true, force: true });
      }),
    );
  });

  it.effect("leaves an existing _current_branch file untouched", () => {
    const workdir = makeWorkdir();
    const branchesDir = join(workdir, "supabase", ".branches");
    mkdirSync(branchesDir, { recursive: true });
    writeFileSync(join(branchesDir, "_current_branch"), "feature-x");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacyStartInitCurrentBranch(fs, path, workdir);
      const content = yield* fs.readFileString(join(branchesDir, "_current_branch"));
      expect(content).toBe("feature-x");
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.map(() => {
        rmSync(workdir, { recursive: true, force: true });
      }),
    );
  });
});
