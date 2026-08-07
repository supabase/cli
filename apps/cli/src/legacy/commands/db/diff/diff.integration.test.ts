import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  LEGACY_FAKE_SHADOW_CONTAINER_ID,
  LEGACY_VALID_REF,
  legacyFailWriteStringOnNthCallFsLayer,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyShadowContainerCliSpawner,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";
import { legacyDbDiff } from "./diff.handler.ts";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isLocal?: boolean;
  readonly linkedRef?: string;
  readonly diffSql?: string;
  // When set, the pg-delta edge mock emits a multi-unit plan envelope (one file
  // per entry) instead of the single-unit wrap of `diffSql`.
  readonly diffFiles?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  readonly oom?: boolean; // edge-runtime OOMs; the bash fallback returns `diffSql`
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
  // When set, the shadow's own PG15+ one-shot platform-baseline job(s) exit
  // non-zero, exercising cleanup-on-partial-failure (the shadow is still removed).
  readonly failShadowSetupJob?: boolean;
  readonly networkId?: string; // --network-id value forwarded to docker runs
  // When set, the Nth `writeFileString` fails, exercising cleanup-on-failure.
  readonly failWriteOnCall?: number;
  // When set, the shadow container never reports healthy — for the interrupt-during-
  // health-wait regression coverage (review: PRRT_kwDOErm0O86XMrID). See
  // `mockLegacyShadowContainerCliSpawner`'s own doc comment for why this is required
  // (not `Effect.never`) to observe a genuinely suspended retry loop.
  readonly neverHealthyShadow?: boolean;
  // `LegacyCliConfig.projectId` (Go's `SUPABASE_PROJECT_ID` env-only reader). Defaults to
  // `Option.some("test")`; pass `Option.none()` to exercise the config.toml/workdir-basename
  // fallback `legacyResolveLocalProjectId` provides for the pg-delta edge-runtime cache bind.
  readonly projectId?: Option.Option<string>;
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** Records every `LegacyDbConnection.connect` target's database name, and every `exec`/`query` SQL run against it. */
function fakeShadowDbConnection() {
  const connectedDatabases: Array<string> = [];
  const execCalls: Array<string> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: LegacyPgConnInput) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        const session: LegacyDbSession = {
          exec: (sql) =>
            Effect.sync(() => {
              execCalls.push(sql);
            }),
          query: () => Effect.succeed([]),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });
  return { layer, connectedDatabases, execCalls };
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const exportCalls: string[] = [];
  const exportCatalogCalls: Array<{ mode: string; projectRef?: string }> = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode, projectRef }) => {
      exportCalls.push(mode);
      exportCatalogCalls.push({ mode, projectRef });
      return Effect.succeed("supabase/.temp/pgdelta/migrations.json");
    },
    execInherit: () => Effect.succeed(0),
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () => Effect.void,
  });

  // Shadow provisioning is native (CLI-1956): a real docker-spawner fake backs
  // container create/start/health-inspect/cleanup, and a real (fake) Postgres
  // session backs the shadow's own platform-baseline/migration/declarative setup.
  const shadowSpawner = mockLegacyShadowContainerCliSpawner({
    neverHealthy: opts.neverHealthyShadow ?? false,
  });
  const shadowDbConnection = fakeShadowDbConnection();

  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      if (opts.oom) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: "Fatal JavaScript out of memory" }),
        );
      }
      const diffSql = opts.diffSql ?? "";
      // The pg-delta diff script (uniquely identified by `renderPlanFiles`) prints a
      // JSON envelope with one file per plan unit; wrap the test's raw SQL into a
      // single-unit envelope so `legacyDiffPgDelta` parses it. The migra script
      // returns raw SQL unchanged.
      const isPgDelta = runOpts.script.includes("renderPlanFiles");
      const planFiles =
        opts.diffFiles !== undefined
          ? opts.diffFiles.map((file, i) => ({
              order: i + 1,
              name: file.name,
              transactionMode: "transactional",
              sql: file.sql,
            }))
          : diffSql.length > 0
            ? [{ order: 1, name: "schema_changes", transactionMode: "transactional", sql: diffSql }]
            : [];
      const stdout =
        isPgDelta && planFiles.length > 0
          ? JSON.stringify({ version: 1, files: planFiles })
          : diffSql;
      return Effect.succeed({ stdout, stderr: "" });
    },
  });

  // `dockerCalls` tracks the migra OOM bash fallback's own `runCapture` calls — the
  // native shadow's PG15+ one-shot setup jobs (`legacyRunStartMigrateJob`) go through
  // `runStream` instead (constant-memory stdout discard, matching Go's `io.Discard`
  // writer for these jobs), so they're tracked separately in `shadowSetupJobCalls`
  // (their `env`, notably `DB_HOST`, is the one shadow-specific parameterization
  // CLI-1956 exists to get right).
  const dockerCalls: unknown[] = [];
  const shadowSetupJobCalls: Array<{ readonly env: Readonly<Record<string, string>> }> = [];
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: (dockerOpts) => {
      dockerCalls.push(dockerOpts);
      return Effect.succeed({
        exitCode: 0,
        stdout: new TextEncoder().encode(opts.diffSql ?? ""),
        stderr: "",
      });
    },
    // The shadow's own PG15+ one-shot platform-baseline job(s).
    runStream: (dockerOpts) => {
      shadowSetupJobCalls.push(dockerOpts);
      return Effect.succeed({
        exitCode: opts.failShadowSetupJob === true ? 1 : 0,
        stderr: "",
      });
    },
  });

  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (resolveFlags) => {
      resolverCalls.push(resolveFlags);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? true,
        ref: opts.linkedRef !== undefined ? Option.some(opts.linkedRef) : Option.none(),
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  // The linked ref is now pre-loaded (for the config-override print, ahead of
  // `resolver.resolve()`'s own network work — review: PRRT_kwDOErm0O86XHvYl) via
  // `LegacyProjectRefResolver`, mirroring the SAME ref `resolver`'s own mock embeds in
  // its resolved `ref` above, so both stay consistent regardless of whether a test sets
  // `opts.linkedRef` (mirrors `reset.integration.test.ts`'s identical mock).
  const projectRefResolver = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? LEGACY_VALID_REF)),
    loadProjectRef: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
  });

  const proxyCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const proxyCaptureCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> =
    [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        proxyCaptureCalls.push({ args, env: execOpts?.env });
        return opts.delegateStdout ?? "";
      }),
  });

  const baseLayer = Layer.mergeAll(
    // `BunServices.layer` is listed FIRST so every fake service layer below (most
    // importantly `shadowSpawner.layer`'s fake `ChildProcessSpawner`) OVERRIDES its
    // real implementation — `Layer.mergeAll` is last-wins on a shared service,
    // matching `start.integration.test.ts`'s own established ordering.
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    edge,
    docker,
    shadowDbConnection.layer,
    shadowSpawner.layer,
    alwaysReadyHttpClientLayer,
    resolver,
    projectRefResolver,
    proxy,
    mockLegacyCliConfig({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyPgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    Layer.succeed(LegacyExperimentalFlag, false),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    mockRuntimeInfo(),
  );
  // Merged last so its `FileSystem` overrides everything above (last-wins).
  const layer =
    opts.failWriteOnCall === undefined
      ? baseLayer
      : Layer.merge(baseLayer, legacyFailWriteStringOnNthCallFsLayer(opts.failWriteOnCall));

  return {
    layer,
    out,
    cache,
    telemetry,
    exportCalls,
    exportCatalogCalls,
    edgeCalls,
    resolverCalls,
    proxyCalls,
    proxyCaptureCalls,
    dockerCalls,
    shadowSetupJobCalls,
    shadowSpawned: shadowSpawner.spawned,
    shadowConnectedDatabases: shadowDbConnection.connectedDatabases,
    shadowExecCalls: shadowDbConnection.execCalls,
  };
}

const flags = (over: Partial<LegacyDbDiffFlags> = {}): LegacyDbDiffFlags => ({
  useMigra: over.useMigra ?? Option.none(),
  usePgAdmin: over.usePgAdmin ?? Option.none(),
  usePgSchema: over.usePgSchema ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  from: over.from ?? Option.none(),
  to: over.to ?? Option.none(),
  output: over.output ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  file: over.file ?? Option.none(),
  schema: over.schema ?? [],
});

const stdout = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join(""),
  );
const stderr = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join(""),
  );

const tmp = useLegacyTempWorkdir();

describe("legacy db diff", () => {
  it.effect("diffs local with the default migra engine and prints SQL to stdout", () => {
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      // The native shadow was created once (one `docker create`) and removed once
      // (one `docker rm -f -v`) — see `mockLegacyShadowContainerCliSpawner`.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table players ();\n\n");
      expect(stderr(s.out)).toContain("Creating shadow database...");
      expect(stderr(s.out)).toContain("Diffing schemas...");
      expect(stderr(s.out)).toContain("Finished supabase db diff on branch");
      expect(s.telemetry.flushed).toBe(true);
      // The shadow's PG15+ one-shot platform-baseline job(s) connect to the shadow over
      // Docker's embedded DNS using the shadow container's OWN 12-char short id as `DB_HOST`
      // (Go's `container[:12]`, `diff.go:172`) — NOT the real `db` container's name, and not
      // some other slice length (a mutation from `.slice(0, 12)` to `.slice(0, 8)` must fail
      // this). This is the one shadow-specific parameterization this port exists to get right
      // (`legacyBuildShadowSetupDatabaseInput`'s `dbHost`). The default config enables realtime
      // (and PG >= 15 by default), so this always exercises at least one one-shot job —
      // Realtime's own env sets `DB_HOST` directly; Storage/Auth embed the same host inside a
      // `DATABASE_URL`-style connection string instead.
      const expectedHost = LEGACY_FAKE_SHADOW_CONTAINER_ID.slice(0, 12);
      expect(s.shadowSetupJobCalls.length).toBeGreaterThan(0);
      let sawHost = false;
      for (const call of s.shadowSetupJobCalls) {
        if (call.env["DB_HOST"] !== undefined) {
          expect(call.env["DB_HOST"]).toBe(expectedHost);
          sawHost = true;
        }
        for (const value of Object.values(call.env)) {
          if (value.includes("@") && value.includes(":")) {
            expect(value).toContain(`@${expectedHost}:`);
            sawHost = true;
          }
        }
      }
      expect(sawHost).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with pgdelta when --use-pg-delta is set", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), schema: ["public"] }));
      // pg-delta selection is observable via the edge-runtime script it runs.
      expect(s.edgeCalls[0]?.script).toContain("renderPlanFiles");
      expect(stderr(s.out)).toContain("Diffing schemas: public");
      expect(stdout(s.out)).toBe("create table p ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "mounts the pg-delta Deno-cache volume by the config/workdir-resolved project id, not just SUPABASE_PROJECT_ID (review: PRRT_kwDOErm0O86XAlIw)",
    () => {
      // No `SUPABASE_PROJECT_ID` env and no `supabase/config.toml` `project_id` — Go's
      // `Config.ProjectId` falls back to the workdir basename (`pkg/config/config.go:563-570`)
      // and `UpdateDockerIds` names the edge-runtime volume from that already-sanitized value
      // (`internal/utils/config.go:57-76`). Before the fix, `ctx.projectId` came from
      // `LegacyCliConfig.projectId` alone (env-only) and resolved to `""`, mounting
      // `supabase_edge_runtime_:/root/.cache/deno:rw` regardless of the real project.
      const s = setup(tmp.current, {
        diffSql: "create table p ();\n",
        projectId: Option.none(),
      });
      const expectedProjectId = basename(tmp.current);
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgDelta: Option.some(true) }));
        expect(s.edgeCalls[0]?.binds).toContain(
          `supabase_edge_runtime_${expectedProjectId}:/root/.cache/deno:rw`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a linked [remotes.<ref>]'s own project_id outranks a conflicting SUPABASE_PROJECT_ID for the pg-delta Deno-cache volume (review: PRRT_kwDOErm0O86XI1w8)",
    () => {
      // `legacyReadDbToml` already gates `cfg.projectId` behind `remoteOverrideKeys` so it
      // reflects the matched remote's OWN `project_id` (review: PRRT_kwDOErm0O86XHGDL) — but
      // `legacyResolveLocalProjectId` tries `cliConfig.projectId` (raw, ungated env) FIRST, so
      // an ambient `SUPABASE_PROJECT_ID` that differs from the matched remote must be
      // suppressed here too, or it silently wins back over the already-gated `cfg.projectId`.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[remotes.staging]", 'project_id = "abcdefghijklmnopqrst"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "create table remote ();\n",
        // Simulates an ambient `SUPABASE_PROJECT_ID` scoped to an unrelated (e.g. local)
        // project — must NOT win over the matched remote's own `project_id`.
        projectId: Option.some("unrelated-env-project"),
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ linked: Option.some(true), usePgDelta: Option.some(true) }));
        expect(s.edgeCalls[0]?.binds).toContain(
          "supabase_edge_runtime_abcdefghijklmnopqrst:/root/.cache/deno:rw",
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("PG14: provisions a shadow via the SQL-exec init path (no PG15+ one-shot jobs)", () => {
    // Go's own shadow test coverage hardcodes PG14 (`diff_test.go`); the PG15+ short-id
    // DNS resolution path was verified separately (empirical Docker probe, see the
    // task's own header) — this covers the OTHER major-version branch of the SAME
    // `legacySetupDatabase` pipeline, which execs SQL directly via the session
    // instead of the three one-shot `LegacyDockerRun` jobs.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 14\n");
    const s = setup(tmp.current, { diffSql: "create table pg14 ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stdout(s.out)).toBe("create table pg14 ();\n\n");
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      // PG14's `legacyStartInitSchemaPre15` execs SQL over the session directly —
      // no one-shot `LegacyDockerRun` jobs (Go's `initSchema15` never runs).
      expect(s.dockerCalls).toEqual([]);
      expect(s.shadowExecCalls.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "removes the shadow even when its own platform-baseline setup fails midway (ok-sentinel cleanup)",
    () => {
      // Mirrors Go's `ok`-sentinel + `defer` pattern (`shadow.go:42-47`): once the
      // shadow container is created, ANY later failure (here, a PG15+ one-shot
      // platform-baseline job exiting non-zero) still removes it.
      const s = setup(tmp.current, { diffSql: "create table x ();\n", failShadowSetupJob: true });
      return Effect.gen(function* () {
        const exit = yield* legacyDbDiff(flags()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // Go loads the project ref before LoadConfig on the linked path, merging the
    // matching [remotes.<ref>] block before experimental.pgdelta.enabled is read
    // (flags/db_url.go:87-97). The default db diff target is local (no merge), so
    // this only applies with --linked; base config disables pg-delta, the remote
    // override enables it, so the diff must pick the pg-delta engine.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = false",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      // pg-delta selection (ref-aware: read from the remote-merged `cfg.pgDelta`) is
      // observable via the edge-runtime script the diff runs.
      expect(s.edgeCalls[0]?.script).toContain("renderPlanFiles");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a linked [remotes.<ref>] db.major_version override reaches the shadow's OWN container spec, not just cfg",
    () => {
      // Go remote-merges the WHOLE config uniformly on the linked path (`LoadConfig` seeds
      // `flags.ProjectRef` before every field read) — the shadow's container spec (image,
      // JWT secret, root key, db.settings, service enabled-for-setup flags) must reflect the
      // matched `[remotes.<ref>]` override too, not just the `cfg`/`toml` read used for
      // pg-delta/schema_paths. `major_version` is a clean, directly-observable probe: PG <= 14
      // is the ONLY branch that emits a `--tmpfs` flag on the shadow's `docker create` argv
      // (`legacyBuildShadowPostgresContainerSpec`) — a base config of 17 (>= 15, no tmpfs)
      // overridden by a remote block's `major_version = 14` must flip that flag on.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          "[db]",
          "major_version = 17",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.db]",
          "major_version = 14",
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ linked: Option.some(true) }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
        // The PG15+ one-shot platform-baseline jobs (`initSchema15`) never run for PG14 —
        // it execs SQL directly over the session instead — corroborating the same override.
        expect(s.dockerCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("the base config (default local target) does not merge a remote block", () => {
    // The default db diff target is local; Go never calls LoadProjectRef for local,
    // so a [remotes.<ref>] override must be ignored and the base engine (migra) wins.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = false",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      // The local default never merges a remote block, so the base (migra) engine wins.
      expect(s.edgeCalls[0]?.script).not.toContain("renderPlanFiles");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs the linked project and writes the linked-project cache", () => {
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // Go's `ensureProjectGroupsCached` (`cmd/root.go:212-233`) reads the GLOBAL
      // `flags.ProjectRef` singleton `LoadProjectRef` sets as a side effect, and runs
      // unconditionally after `rootCmd.ExecuteC()` regardless of whether the command itself
      // errored — so a ref resolved via `LoadProjectRef` gets cached even when a LATER step
      // (here, `legacyReadDbToml`'s own config-load) fails. `db.migrations.enabled = "notabool"`
      // fails `legacyReadDbToml`'s own bool parse AFTER the ref is already known, exercising
      // exactly that gap.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[db.migrations]", 'enabled = "notabool"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbDiff(flags({ linked: Option.some(true) })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "provisions a local-target declarative shadow and diffs against the override database",
    () => {
      // A declarative schema file under supabase/schemas makes `loadDeclaredSchemas`
      // non-empty, so the native `--target-local` branch redirects the diff target to
      // a second (contrib_regression) database on the SAME shadow container.
      mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "schemas", "public.sql"), "select 1;\n");
      const s = setup(tmp.current, { diffSql: "create table o ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags());
        expect(stdout(s.out)).toBe("create table o ();\n\n");
        // The declarative-schema file was migrated into the contrib_regression override.
        expect(s.shadowConnectedDatabases).toContain("contrib_regression");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("delegates --use-pgadmin to the Go binary (telemetry disabled on the child)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
      expect(s.proxyCalls).toHaveLength(1);
      expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pgadmin"]);
      expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
      // The pgadmin/pg-schema delegate short-circuits before ever creating a shadow.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a delegated --use-pgadmin does not validate the base config first", () => {
    // The delegate forwards the whole command to the Go child, which loads config
    // itself (with the linked ref). So the TS path must NOT read/validate the base
    // config up front — otherwise a project that's only valid after a [remotes.<ref>]
    // merge (here: base db.major_version=16 is invalid) fails before delegating,
    // even though Go validates the remote-merged config and succeeds.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
    const s = setup(tmp.current, { isLocal: false, linkedRef: "abcdefghijklmnopqrst" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
      expect(s.proxyCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a native local diff still validates the base config", () => {
    // Control for the delegate case: the local/db-url native path reads the base
    // config (Go's local LoadConfig, no remote merge), so an invalid base value
    // (db.major_version=16) must still fail — matching Go.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
    const s = setup(tmp.current, { diffSql: "create table x ();\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "validates the shadow's own local config (api.tls cert file) BEFORE resolving the connection",
    () => {
      // `db.major_version` above is caught by `cfg` (`legacyReadDbToml`'s "D" pipeline),
      // which already runs ahead of `resolver.resolve()`. `api.tls` is "L only" — `cfg`
      // only tracks its dotted keys for remote-override gating, it never reads the cert/key
      // files (see `legacyBuildLocalDbContainerInputs`'s doc comment) — so this is the ONE
      // config error only `legacyBuildLocalDbContainerInputs`'s own validation catches. Go
      // validates it as part of `LoadConfig`, in the root `PersistentPreRunE`, strictly
      // before `NewDbConfigWithPassword` (`resolver.resolve()`'s parity target) ever runs
      // (review: PRRT_kwDOErm0O86XIUK1) — so `resolverCalls` must stay empty here, proving
      // the shadow's config validation ran first, not just that the command failed.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          "[api]",
          "enabled = true",
          "[api.tls]",
          "enabled = true",
          'cert_path = "missing-cert.pem"',
          'key_path = "missing-key.pem"',
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, { diffSql: "create table x ();\n" });
      return Effect.gen(function* () {
        const error = yield* legacyDbDiff(flags()).pipe(Effect.flip);
        expect(error.message).toContain("failed to read TLS cert");
        expect(s.resolverCalls).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("re-quotes a comma-containing schema when delegating the diff", () => {
    // flags.schema holds the single parsed value `tenant,one`; forwarding it raw
    // would let the Go child's pflag StringSlice CSV-split it into two schemas, so
    // it must be re-encoded as a quoted CSV field.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), schema: ["tenant,one"] }));
      const args = s.proxyCalls[0]?.args ?? [];
      const idx = args.indexOf("--schema");
      expect(args[idx + 1]).toBe('"tenant,one"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("delegates --use-pg-schema to the Go binary without a duplicate warning", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgSchema: Option.some(true) }));
      // The delegated Go `db diff --use-pg-schema` prints the experimental
      // warning itself; the TS wrapper must not print a second copy.
      expect(stderr(s.out)).not.toContain("--use-pg-schema flag is experimental");
      expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pgadmin in json mode wraps the captured SQL in a structured envelope", () => {
    // Regression: the delegated child inherited stdout and returned without
    // output.success, so machine-mode stdout carried the Go child's raw SQL
    // instead of a JSON envelope (CLI-1546). Now the child's stdout is captured
    // and re-emitted as the structured payload.
    const s = setup(tmp.current, { format: "json", delegateStdout: "create table d ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
      // stdout stays payload-only; the child's SQL was captured, not inherited.
      expect(stdout(s.out)).toBe("");
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table d ();\n",
        file: null,
        engine: "pgadmin",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pg-schema in json mode wraps the captured SQL in a structured envelope", () => {
    const s = setup(tmp.current, { format: "json", delegateStdout: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgSchema: Option.some(true) }));
      expect(stdout(s.out)).toBe("");
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ diff: "create table e ();\n", engine: "pg-schema" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes a timestamped migration when --file is set instead of printing", () => {
    const s = setup(tmp.current, { diffSql: "create table f ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ file: Option.some("my_diff") }));
      expect(stdout(s.out)).toBe("");
      expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_my_diff\.sql$/);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes one migration file per unit for a multi-unit pg-delta plan", () => {
    // A pg-delta plan that crosses a transaction boundary yields more than one
    // ordered unit; writing them into one migration would fail when db push/reset
    // applies it as a single transaction. Each unit becomes its own file (Go's
    // WritePgDeltaMigrations), named `<name>_<unit>` with strictly increasing
    // timestamps, and the machine payload's `files` lists them all.
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^\d{14}_my_diff_schema_changes\.sql$/);
      expect(files[1]).toMatch(/^\d{14}_my_diff_after_enum_values\.sql$/);
      // Each unit's file carries only that unit's SQL, terminated with a newline.
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("alter type mood add value 'ok';\n");
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { file: string; files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      // `file` stays the first written path for released string-field consumers.
      expect(data.file).toBe(data.files[0]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested single-unit --file name", () => {
    // `db diff -f snapshots/remote` must create the `<ts>_snapshots/` parent dir
    // before writing, mirroring Go's `utils.WriteFile`.
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ file: Option.some("snapshots/remote") }));
      const migrationsRoot = join(tmp.current, "supabase", "migrations");
      const dirs = readdirSync(migrationsRoot);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
      expect(readdirSync(join(migrationsRoot, dirs[0]!))).toEqual(["remote.sql"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested multi-unit --file name", () => {
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("snapshots/remote") }),
      );
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      for (const written of data.files) expect(existsSync(written)).toBe(true);
      expect(data.files[0]).toMatch(/\d{14}_snapshots\/remote_schema_changes\.sql$/u);
      expect(data.files[1]).toMatch(/\d{14}_snapshots\/remote_after_enum_values\.sql$/u);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bumps the version set when a target migration file already exists", () => {
    // The full generated set is collision-checked before writing; if any target
    // exists the base advances one second so the new files stay strictly ascending
    // AND never overwrite the pre-existing migration.
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "a" },
        { name: "after_enum_values", sql: "b" },
      ],
    });
    return Effect.gen(function* () {
      const dir = join(tmp.current, "supabase", "migrations");
      mkdirSync(dir, { recursive: true });
      // TestClock starts at epoch 0, so the first version the writer tries is
      // 19700101000000; pre-seed a colliding file at that version.
      const clashing = join(dir, "19700101000000_my_diff_schema_changes.sql");
      writeFileSync(clashing, "-- pre-existing\n");
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(readdirSync(dir).sort()).toEqual([
        "19700101000000_my_diff_schema_changes.sql",
        "19700101000001_my_diff_schema_changes.sql",
        "19700101000002_my_diff_after_enum_values.sql",
      ]);
      // The pre-existing file was never overwritten.
      expect(readFileSync(clashing, "utf8")).toBe("-- pre-existing\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("removes already-written unit files when a later unit write fails", () => {
    // A mid-loop write failure best-effort removes every file this invocation
    // already wrote, so no partial multi-file migration is left behind.
    const s = setup(tmp.current, {
      format: "json",
      failWriteOnCall: 2,
      diffFiles: [
        { name: "schema_changes", sql: "a" },
        { name: "after_enum_values", sql: "b" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const dir = join(tmp.current, "supabase", "migrations");
      const remaining = existsSync(dir) ? readdirSync(dir) : [];
      expect(remaining).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to linked prints the diff to stdout", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("local"), to: Option.some("linked") }));
      // Explicit mode is pg-delta and never provisions a shadow.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
      expect(stdout(s.out)).toBe("create table e ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --output writes raw SQL to the given path", () => {
    const s = setup(tmp.current, { diffSql: "create table w ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          output: Option.some("out.sql"),
        }),
      );
      expect(existsSync(join(tmp.current, "out.sql"))).toBe(true);
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("forwards an explicit --linked=false target flag to the delegated child", () => {
    // Target flags are selectors keyed on flag.Changed in Go; dropping Some(false)
    // would make the child default to local instead of the linked target the
    // native path selected.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(false) }));
      expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pgadmin", "--linked=false"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an empty --file value prints to stdout instead of writing a nameless migration",
    () => {
      // Go's SaveDiff gates the file write on len(file) > 0; an empty --file (e.g.
      // an unset shell var) falls through to stdout rather than writing
      // `<timestamp>_.sql`.
      const s = setup(tmp.current, { diffSql: "create table y ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ file: Option.some("") }));
        expect(stdout(s.out)).toContain("create table y ();");
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "explicit --output with an empty value prints to stdout instead of writing a file",
    () => {
      // Go gates the file write on len(outputPath) > 0; an empty value falls through
      // to stdout rather than writing SQL into the project directory.
      const s = setup(tmp.current, { diffSql: "create table z ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ from: Option.some("local"), to: Option.some("local"), output: Option.some("") }),
        );
        // Reaching stdout proves it didn't try to write SQL to the resolved workdir.
        expect(stdout(s.out)).toBe("create table z ();\n");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("explicit --from migrations resolves a shadow catalog via the seam", () => {
    const s = setup(tmp.current, { diffSql: "create table m ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("local") }));
      expect(s.exportCalls).toEqual(["migrations"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "explicit --from linked --to migrations exports the catalog with the linked ref",
    () => {
      // Go resolves linked first (LoadConfig merges [remotes.<ref>]), so the later
      // migrations catalog is built from the remote-merged config (explicit.go).
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "create table m ();\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ from: Option.some("linked"), to: Option.some("migrations") }));
        const migrations = s.exportCatalogCalls.find((c) => c.mode === "migrations");
        expect(migrations?.projectRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("explicit --from migrations --to linked exports the catalog with base config", () => {
    // Migrations is resolved BEFORE linked here, so Go's LoadConfig(ref) hasn't run
    // yet — the catalog must use base config (no ref forwarded), matching order.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("linked") }));
      const migrations = s.exportCatalogCalls.find((c) => c.mode === "migrations");
      expect(migrations?.projectRef).toBeUndefined();
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked seeds the merged config", () => {
    // Go's root ParseDatabaseConfig runs LoadProjectRef+LoadConfig for a changed
    // --linked before RunExplicit, leaving the config remote-merged — so the
    // migrations catalog (and local refs/format options) use the linked override
    // even though neither explicit ref is itself `linked`.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      );
      const migrations = s.exportCatalogCalls.find((c) => c.mode === "migrations");
      expect(migrations?.projectRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked validates the merged config", () => {
    // The explicit base config read is deferred until after the linked preflight, so
    // a base config that's only valid after the [remotes.<ref>] merge (base
    // major_version=16, override=15) does not fail before the ref is resolved —
    // matching Go's stateful pre-run (LoadConfig after LoadProjectRef on --linked).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db]",
        "major_version = 16",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.db]",
        "major_version = 15",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty --from/--to (shell vars) fall through to the normal diff", () => {
    // Go gates explicit mode on len(diffFrom)>0 || len(diffTo)>0; `--from "" --to ""`
    // is unset and runs the normal local diff, not an unknown-target error.
    const s = setup(tmp.current, { diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some(""), to: Option.some("") }));
      // Reaching the native path proves it didn't enter explicit mode and error.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table e ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an explicit --from with an empty --to still errors 'must set both'", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ from: Option.some("local"), to: Option.some("") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit mode still runs the target-flag preflight on a changed --db-url", () => {
    // Go runs ParseDatabaseConfig in PreRun before RunExplicit (cmd/root.go:118),
    // so a changed target flag is still validated/loaded even when the explicit
    // refs drive the diff. The preflight resolves the --db-url target (connType
    // db-url); a real bad URL would surface the resolver's parse error.
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          dbUrl: Option.some("postgresql://x"),
        }),
      );
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "db-url" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails when --from is set without --to", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(flags({ from: Option.some("local") })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on engine-flag conflict (--use-migra with --use-pg-delta)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ useMigra: Option.some(true), usePgDelta: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on target mutex (--linked with --local)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ linked: Option.some(true), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("warns on drop statements in the diff", () => {
    const s = setup(tmp.current, { diffSql: "drop table gone;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).toContain("Found drop statements in schema diff");
      expect(stderr(s.out)).toContain("drop table gone");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("emits a json envelope with --output-format json (payload-only stdout)", () => {
    const s = setup(tmp.current, { format: "json", diffSql: "create table j ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      // No raw SQL on stdout in machine mode; the envelope carries it instead.
      expect(stdout(s.out)).toBe("");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table j ();\n",
        file: null,
        engine: "migra",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("prints 'No schema changes found' and exits 0 on an empty diff", () => {
    const s = setup(tmp.current, { diffSql: "" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).toContain("No schema changes found");
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("falls back to the migra Docker image when edge-runtime OOMs", () => {
    const s = setup(tmp.current, { oom: true, diffSql: "create table fb ();\n", isLocal: true });
    return Effect.gen(function* () {
      // Pass --schema so the fallback does not need a live DB to list schemas.
      yield* legacyDbDiff(flags({ schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table fb ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the migra OOM fallback honors --network-id over host networking", () => {
    // Go's bash fallback routes through DockerStart, which overrides the requested
    // host network with --network-id when set (internal/utils/docker.go:266-271).
    const s = setup(tmp.current, {
      oom: true,
      diffSql: "create table fb ();\n",
      isLocal: true,
      networkId: "my-net",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect((s.dockerCalls[0] as { network: unknown }).network).toEqual({
        _tag: "named",
        name: "my-net",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.live(
    "removes the shadow container on a SIGINT-style interruption during the health wait, without waiting for the health-check timeout",
    () => {
      // Regression test for the acquireUseRelease restructuring (review:
      // PRRT_kwDOErm0O86XMrID): an earlier shape passed the ENTIRE
      // `legacyPrepareShadowSource` (create -> health-wait -> migrate ->
      // declarative-apply) as `acquireUseRelease`'s `acquire`, which Effect's
      // `uninterruptibleMask` (no `restore` around `acquire`) made completely
      // uninterruptible — a SIGINT landing during the health wait (which can run for
      // up to 30 real seconds, `LEGACY_HEALTH_CHECK_TIMEOUT_SECONDS`) was silently
      // swallowed until the health check gave up on its own, unlike Go's single
      // cancellable `ctx`. `acquire` is now ONLY `legacyCreateShadowDatabase`
      // (container creation); the health wait runs inside the interruptible `use`
      // phase instead, so a `Fiber.interrupt` here must land promptly.
      const s = setup(tmp.current, { neverHealthyShadow: true });
      return Effect.gen(function* () {
        const fiber = yield* legacyDbDiff(flags()).pipe(
          Effect.provide(s.layer),
          Effect.forkChild({ startImmediately: true }),
        );
        // Wait until the shadow's own health check has actually probed the
        // never-healthy container at least once — proving the fiber is genuinely
        // suspended inside `legacyWaitForHealthyServices`'s retry loop, not merely
        // past the `create` call.
        while (!s.shadowSpawned.some((c) => c.args[0] === "container" && c.args[1] === "inspect")) {
          yield* Effect.sleep("5 millis");
        }
        // `Fiber.interrupt` only resolves once the target fiber (and its finalizers,
        // including `legacyRemoveShadowDatabase`) has fully completed — if `acquire`
        // still covered the health wait, this call would hang for up to 30 real
        // seconds (or until this test's own timeout), instead of resolving as soon
        // as the in-flight probe's own subprocess call returns.
        yield* Fiber.interrupt(fiber);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        // The diff step (past the health wait) was never reached.
        expect(s.edgeCalls).toHaveLength(0);
      });
    },
  );
});
