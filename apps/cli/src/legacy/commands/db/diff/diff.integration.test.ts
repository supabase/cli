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
  legacySequentialExecBatch,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRunError } from "../../../shared/legacy-docker-run.errors.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDatabaseDiffInput,
  type LegacyPgDeltaExplicitDiffInput,
  type LegacyPgDeltaHazardReport,
} from "../shared/legacy-pgdelta-engine.service.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";
import { legacyDbDiff } from "./diff.handler.ts";
import {
  LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX,
  LEGACY_PGADMIN_DIFF_HEADER,
} from "./legacy-pgadmin-diff.ts";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isLocal?: boolean;
  readonly linkedRef?: string;
  readonly diffSql?: string;
  // When set, the pg-delta strategy mock returns one rendered file per entry.
  readonly diffFiles?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  // Exact suffixes returned by the next renderer, parallel to `diffFiles`.
  readonly diffSuffixes?: ReadonlyArray<string | null>;
  readonly hazards?: LegacyPgDeltaHazardReport;
  readonly pgDeltaImplementation?: "legacy" | "next";
  readonly oom?: boolean; // edge-runtime OOMs; the bash fallback returns `diffSql`
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
  // When set, the PGDELTA_DEBUG shadow-catalog export fails with this message
  // instead of succeeding.
  readonly catalogExportFailWith?: string;
  readonly diffFailWith?: string;
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
  // `LegacyCliConfig.projectId` (the `SUPABASE_PROJECT_ID` env-only reader). Defaults
  // to `Option.some("test")`; pass `Option.none()` to exercise the
  // config.toml/workdir-basename fallback `legacyResolveLocalProjectId` provides for
  // the pg-delta edge-runtime cache bind.
  readonly projectId?: Option.Option<string>;
  // Simulates a genuinely unlinked workdir: `loadProjectRef` fails with
  // `LegacyProjectNotLinkedError` absent an explicit `--project-ref` flag,
  // instead of silently falling back to `opts.linkedRef ?? LEGACY_VALID_REF`.
  readonly linkedFails?: boolean;
  // --- CLI-1968 (native --use-pgadmin) ---
  // Per-differ-run `--json-diff` stdout, one entry per `runCapture` call to the differ
  // image (index 0 = the no-`--schema` run, or the 1st `--schema` run; index 1 = the
  // 2nd `--schema` run; …). Falls back to `""` (an empty/"No schema changes" diff) once
  // exhausted, so a single-run test only needs a one-element array.
  readonly pgadminStdout?: ReadonlyArray<string>;
  // Per-differ-run stderr (the raw text `legacyProcessPgAdminDiffProgress` filters).
  // Falls back to `""` once exhausted.
  readonly pgadminStderr?: ReadonlyArray<string>;
  // Applied to every differ `runCapture` call (the failure tests below only ever drive
  // a single, no-`--schema` run, so one number covers them).
  readonly pgadminExitCode?: number;
  // Makes every differ `runCapture` call fail at the docker boundary instead of
  // returning a result — `"spawn"` (daemon unreachable) or `"pull"` (registry failure).
  readonly pgadminDockerFail?: "spawn" | "pull";
  // Makes the pre-flight `docker container inspect supabase_db_<projectId>` probe
  // (`legacyIsLocalDbRunning`, run before `--use-pgadmin` provisions anything) report
  // "container not found" — surfaces as "supabase start is not running.".
  readonly dbNotRunning?: boolean;
  // Makes that SAME probe fail with a daemon-unreachable stderr instead — the
  // `daemonDown: true` classification branch. Mutually exclusive with `dbNotRunning`.
  readonly dbInspectFailsWith?: string;
  // `RuntimeInfo.platform` — drives the differ's `--add-host host.docker.internal:
  // host-gateway` (Linux-only). Defaults to `"linux"` (every other test's implicit
  // baseline); pass `"darwin"`/`"win32"` to exercise the no-add-host branch.
  readonly platform?: NodeJS.Platform;
  // The remote target's answer to the linked auto-expose drift probe
  // (`pg_default_acl`, only dialed when `isLocal: false`): a boolean serves one
  // probe row, `undefined` serves no rows (the check skips), and
  // `remoteTargetConnectFails` fails the probe's own connect instead — the check
  // must swallow that and let the diff proceed.
  readonly remoteAutoExpose?: boolean;
  readonly remoteTargetConnectFails?: boolean;
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** Records every `LegacyDbConnection.connect` target's database name, and every `exec`/`query` SQL run against it. */
function fakeShadowDbConnection(opts: SetupOpts = {}) {
  const connectedDatabases: Array<string> = [];
  const execCalls: Array<string> = [];
  let autoExposeProbeCalls = 0;
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: LegacyPgConnInput) => {
      // The resolver mock's remote target always dials 54322; the native shadow
      // dials its own schema-default port — so failing 54322 fails exactly the
      // auto-expose drift probe's short-lived connection and nothing else.
      if (cfg.port === 54322 && opts.remoteTargetConnectFails === true) {
        return Effect.fail(new LegacyDbConnectError({ message: "connection refused" }));
      }
      return Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        const session: LegacyDbSession = {
          exec: (sql) =>
            Effect.sync(() => {
              execCalls.push(sql);
            }),
          query: (sql) => {
            if (/pg_default_acl/u.test(sql)) {
              autoExposeProbeCalls += 1;
              return Effect.succeed(
                opts.remoteAutoExpose === undefined
                  ? ([] as ReadonlyArray<Record<string, unknown>>)
                  : [{ auto_expose: opts.remoteAutoExpose }],
              );
            }
            return Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
          },
          execBatch: (statements) => legacySequentialExecBatch(session)(statements),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      });
    },
  });
  return {
    layer,
    connectedDatabases,
    execCalls,
    get autoExposeProbeCalls() {
      return autoExposeProbeCalls;
    },
  };
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  // A real docker-spawner fake backs container create/start/health-inspect/cleanup,
  // and a real (fake) Postgres session backs the shadow's own
  // platform-baseline/migration/declarative setup.
  const shadowSpawner = mockLegacyShadowContainerCliSpawner({
    neverHealthy: opts.neverHealthyShadow ?? false,
    dbNotRunning: opts.dbNotRunning ?? false,
    dbInspectFailsWith: opts.dbInspectFailsWith,
  });
  const shadowDbConnection = fakeShadowDbConnection(opts);

  const explicitDiffCalls: LegacyPgDeltaExplicitDiffInput[] = [];
  const databaseDiffCalls: LegacyPgDeltaDatabaseDiffInput[] = [];
  const pgDeltaResult = () => {
    const sql = opts.diffSql ?? "";
    const files =
      opts.diffFiles !== undefined
        ? opts.diffFiles.map((file, index) => ({
            sequence: index + 1,
            name: file.name,
            ...(opts.diffSuffixes?.[index] !== undefined
              ? { suffix: opts.diffSuffixes[index] }
              : {}),
            sql: file.sql,
            transactionMode: "transactional" as const,
          }))
        : sql.length > 0
          ? [
              {
                sequence: 1,
                name: "schema_changes",
                sql,
                transactionMode: "transactional" as const,
              },
            ]
          : [];
    return {
      changes: files.length > 0,
      sql: opts.diffFiles !== undefined ? files.map((file) => file.sql).join("\n\n") : sql,
      files,
      ...(opts.hazards !== undefined ? { hazards: opts.hazards } : {}),
    };
  };
  const pgDeltaEngine = Layer.succeed(
    LegacyPgDeltaEngine,
    LegacyPgDeltaEngine.of({
      // The handler must route through this strategy even when the selected
      // implementation is legacy; the strategy owns edge runtime and shadows.
      implementation: opts.pgDeltaImplementation ?? "legacy",
      diffExplicit: (input) =>
        Effect.sync(() => {
          explicitDiffCalls.push(input);
          return pgDeltaResult();
        }),
      diffDatabase: (input) =>
        Effect.sync(() => {
          databaseDiffCalls.push(input);
          return pgDeltaResult();
        }),
      exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema unused"),
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
    }),
  );

  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      if (opts.oom) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: "Fatal JavaScript out of memory" }),
        );
      }
      // The PGDELTA_DEBUG shadow-catalog export uses a distinct errPrefix (`legacy-
      // pgdelta.ts`'s `legacyExportCatalogPgDelta`), same as `db pull`'s own mock.
      if (runOpts.errPrefix.includes("catalog")) {
        if (opts.catalogExportFailWith !== undefined) {
          return Effect.fail(
            new LegacyEdgeRuntimeScriptError({ message: opts.catalogExportFailWith }),
          );
        }
        return Effect.succeed({ stdout: '{"tables":[]}', stderr: "" });
      }
      if (opts.diffFailWith !== undefined) {
        return Effect.fail(new LegacyEdgeRuntimeScriptError({ message: opts.diffFailWith }));
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
  // `runStream` instead (constant-memory stdout discard), so they're tracked
  // separately in `shadowSetupJobCalls` (their `env`, notably `DB_HOST`, is the one
  // shadow-specific parameterization that matters to get right).
  const dockerCalls: unknown[] = [];
  // The pgAdmin differ's own `runCapture` calls, tracked separately from
  // `dockerCalls` (the migra OOM bash fallback's image) so pgadmin tests never
  // conflate the two — both go through the SAME `LegacyDockerRun.runCapture` seam,
  // distinguished only by `image`.
  const differCalls: Array<LegacyDockerRunOpts> = [];
  // The `runCapture` SECOND (options) argument for every differ call, parallel to
  // `differCalls` — pinned `undefined` below, since the differ's raw stderr is
  // never teed to the parent terminal (see `legacy-pgadmin-diff.ts`'s own doc
  // comment).
  const differCaptureOpts: Array<{ readonly teeStderr?: boolean } | undefined> = [];
  // Snapshots `process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]` at the moment each
  // differ `runCapture` call is made — the real `legacyDockerRunLayer`'s own image
  // resolver reads that key straight off `process.env` at call time (no
  // `projectEnvValues` threaded through), so this stands in for it here.
  const differRegistryEnvAtCall: Array<string | undefined> = [];
  const shadowSetupJobCalls: Array<{ readonly env: Readonly<Record<string, string>> }> = [];
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: (dockerOpts, captureOpts) => {
      if (dockerOpts.image.includes("pgadmin-schema-diff")) {
        differCalls.push(dockerOpts);
        differCaptureOpts.push(captureOpts);
        differRegistryEnvAtCall.push(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]);
        if (opts.pgadminDockerFail !== undefined) {
          return Effect.fail(
            new LegacyDockerRunError({
              message: "failed to run docker: not found",
              reason: opts.pgadminDockerFail,
              daemonDown: opts.pgadminDockerFail === "spawn",
            }),
          );
        }
        const i = differCalls.length - 1;
        return Effect.succeed({
          exitCode: opts.pgadminExitCode ?? 0,
          stdout: new TextEncoder().encode(opts.pgadminStdout?.[i] ?? ""),
          stderr: opts.pgadminStderr?.[i] ?? "",
        });
      }
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
      // A threaded `--project-ref` flag wins over the fixed `opts.linkedRef` test
      // fixture, same top precedence a real resolver would give it — lets a test
      // prove the flag (not just `opts.linkedRef`) drives the resolved ref (read
      // by both the native path and explicit mode's "linked" case).
      const flagRef = resolveFlags.linkedProjectRef ?? Option.none();
      const ref =
        Option.isSome(flagRef) && flagRef.value.length > 0 ? flagRef.value : opts.linkedRef;
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? true,
        ref: ref !== undefined ? Option.some(ref) : Option.none(),
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  // The linked ref is now pre-loaded (for the config-override print, ahead of
  // `resolver.resolve()`'s own network work — review: PRRT_kwDOErm0O86XHvYl) via
  // `LegacyProjectRefResolver`, mirroring the SAME ref `resolver`'s own mock embeds in
  // its resolved `ref` above, so both stay consistent regardless of whether a test sets
  // `opts.linkedRef` (mirrors `reset.integration.test.ts`'s identical mock).
  // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, same
  // as Go's `flags.LoadProjectRef` — mirror that so a test can prove the flag
  // (not just `opts.linkedRef`) drives the linked ref.
  const projectRefResolver = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
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
    pgDeltaEngine,
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
    mockRuntimeInfo({ platform: opts.platform ?? "linux" }),
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
    explicitDiffCalls,
    databaseDiffCalls,
    edgeCalls,
    resolverCalls,
    proxyCalls,
    proxyCaptureCalls,
    dockerCalls,
    differCalls,
    differCaptureOpts,
    differRegistryEnvAtCall,
    shadowSetupJobCalls,
    shadowSpawned: shadowSpawner.spawned,
    shadowConnectedDatabases: shadowDbConnection.connectedDatabases,
    shadowExecCalls: shadowDbConnection.execCalls,
    get autoExposeProbeCalls() {
      return shadowDbConnection.autoExposeProbeCalls;
    },
  };
}

const flags = (over: Partial<LegacyDbDiffFlags> = {}): LegacyDbDiffFlags => ({
  useMigra: over.useMigra ?? Option.none(),
  usePgAdmin: over.usePgAdmin ?? Option.none(),
  usePgSchema: over.usePgSchema ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  strictCoverage: over.strictCoverage ?? false,
  from: over.from ?? Option.none(),
  to: over.to ?? Option.none(),
  output: over.output ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  projectRef: over.projectRef ?? Option.none(),
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

// --- native --use-pgadmin fixtures ---

/** `DiffEntry` shape, defaulting to a kept entry. */
function pgadminEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "table",
    status: "Different",
    diff_ddl: "ALTER TABLE test;",
    group_name: "public",
    ...overrides,
  };
}

/** `legacyProcessPgAdminDiffOutput`'s exact output for a single default `pgadminEntry()`. */
const PGADMIN_DIFF_SQL = `${LEGACY_PGADMIN_DIFF_HEADER}\n\nALTER TABLE test;\n`;

// The default `resolver`/shadow-port fixtures in `setup()` below (conn
// 127.0.0.1:54322, shadow port 54320) — `source` is the user's db (via
// `legacyToPostgresURL`) and `target` is the shadow (a raw, hardcoded connection
// string).
const PGADMIN_SOURCE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10";
const PGADMIN_TARGET_URL = "postgresql://postgres:postgres@127.0.0.1:54320/postgres";

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
      // Docker's embedded DNS using the shadow container's OWN 12-char short id as
      // `DB_HOST` — NOT the real `db` container's name, and not some other slice length
      // (a mutation from `.slice(0, 12)` to `.slice(0, 8)` must fail this). This is the
      // one shadow-specific parameterization that matters
      // (`legacyBuildShadowSetupDatabaseInput`'s `dbHost`). The default config enables
      // realtime (and PG >= 15 by default), so this always exercises at least one
      // one-shot job — Realtime's own env sets `DB_HOST` directly; Storage/Auth embed
      // the same host inside a `DATABASE_URL`-style connection string instead.
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

  it.effect("a linked diff warns when the remote project still auto-exposes new tables", () => {
    const s = setup(tmp.current, {
      isLocal: false,
      diffSql: "create table players ();\n",
      remoteAutoExpose: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      expect(s.autoExposeProbeCalls).toBe(1);
      const err = stderr(s.out);
      expect(err).toContain(
        "WARNING: auto_expose_new_tables is enabled on the linked project but unset (treated as disabled) in your local config.",
      );
      expect(err).toContain("supabase migration new disable_auto_expose_new_tables");
      // The warning lands before shadow provisioning, ahead of the diff output.
      expect(err.indexOf("WARNING: auto_expose_new_tables")).toBeLessThan(
        err.indexOf("Creating shadow database..."),
      );
      expect(stdout(s.out)).toBe("create table players ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a failed auto-expose drift probe connection never fails a linked diff", () => {
    const s = setup(tmp.current, {
      isLocal: false,
      diffSql: "create table players ();\n",
      remoteTargetConnectFails: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      expect(s.autoExposeProbeCalls).toBe(0);
      expect(stderr(s.out)).not.toContain("WARNING: auto_expose_new_tables");
      expect(stdout(s.out)).toBe("create table players ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a local diff never dials the auto-expose drift probe", () => {
    const s = setup(tmp.current, { diffSql: "", remoteAutoExpose: true });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(s.autoExposeProbeCalls).toBe(0);
      expect(stderr(s.out)).not.toContain("WARNING: auto_expose_new_tables");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with pgdelta when --use-pg-delta is set", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), strictCoverage: true, schema: ["public"] }),
      );
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.databaseDiffCalls[0]).toMatchObject({
        source: {
          kind: "database",
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
        schema: ["public"],
        strictCoverage: true,
        target: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      });
      // Even the legacy implementation is hidden behind LegacyPgDeltaEngine;
      // the handler no longer invokes edge runtime itself.
      expect(s.edgeCalls).toEqual([]);
      expect(stderr(s.out)).toContain("Diffing schemas: public");
      expect(stdout(s.out)).toBe("create table p ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("next local diff ignores schema_paths and declarative files", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "configured.sql"), "create table configured ();\n");
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "ignored.sql"),
      "create table ignored ();\n",
    );
    const s = setup(tmp.current, {
      pgDeltaImplementation: "next",
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeFiles");
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeManifest");
      expect(s.shadowConnectedDatabases).not.toContain("contrib_regression");
      expect(s.databaseDiffCalls[0]?.target.ref).toContain("@127.0.0.1:54322/postgres");
      expect(s.databaseDiffCalls[0]?.target).toMatchObject({
        connection: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        connectOptions: { isLocal: true, dnsResolver: "native" },
      });
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
      expect(stdout(s.out)).toBe("create table result ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  // The transition warning is only true for the bundled next engine. Every other
  // engine still routes a local target with declarative files through the
  // declared-schema `contrib_regression` override, so schema_paths DOES still shape
  // their output and claiming otherwise would be a lie.
  const writeSchemaPathsConfig = (pgDeltaEnabled: boolean) => {
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        `enabled = ${pgDeltaEnabled}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "configured.sql"), "create table configured ();\n");
  };

  it.effect("legacy pg-delta local diff does not print the schema_paths transition warning", () => {
    writeSchemaPathsConfig(true);
    const s = setup(tmp.current, {
      pgDeltaImplementation: "legacy",
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(stderr(s.out)).not.toContain("schema_paths no longer changes the migrations baseline");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("PG14: provisions a shadow via the SQL-exec init path (no PG15+ one-shot jobs)", () => {
    // This covers the PG14 branch of the `legacySetupDatabase` pipeline, which execs
    // SQL directly via the session instead of the three one-shot `LegacyDockerRun`
    // jobs (the PG15+ short-id DNS resolution path is covered separately).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 14\n");
    const s = setup(tmp.current, { diffSql: "create table pg14 ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stdout(s.out)).toBe("create table pg14 ();\n\n");
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      // PG14's `legacyStartInitSchemaPre15` execs SQL over the session directly —
      // no one-shot `LegacyDockerRun` jobs run for this branch.
      expect(s.dockerCalls).toEqual([]);
      expect(s.shadowExecCalls.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "removes the shadow even when its own platform-baseline setup fails midway (ok-sentinel cleanup)",
    () => {
      // Once the shadow container is created, ANY later failure (here, a PG15+
      // one-shot platform-baseline job exiting non-zero) still removes it.
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
    // The linked path merges the matching [remotes.<ref>] block before
    // experimental.pgdelta.enabled is read. The default db diff target is local (no
    // merge), so this only applies with --linked; base config disables pg-delta, the
    // remote override enables it, so the diff must pick the pg-delta engine.
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
      expect(s.databaseDiffCalls[0]?.target.connectOptions.isLocal).toBe(false);
      expect(s.databaseDiffCalls[0]?.source.connectOptions.isLocal).toBe(true);
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

  it.effect("diffs the project given via --project-ref without a linked workdir", () => {
    // The fake resolver fails as "unlinked" (`LegacyProjectNotLinkedError`)
    // absent the flag — only the flag can resolve a ref here.
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, {
      isLocal: false,
      diffSql: "alter table x;\n",
      linkedFails: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    // The workdir already resolves to LEGACY_VALID_REF (e.g. via
    // .temp/project-ref) — the flag must win over it.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
      expect(s.cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbDiff(flags({ local: Option.some(true), projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      // The guard fires before any connection resolution or cache write.
      expect(s.resolverCalls).toEqual([]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "explicit --from linked --to migrations --project-ref proceeds and uses the flag ref",
    () => {
      // The `[remotes.staging]` block's `project_id` matches the FLAG ref, not the
      // resolver's own `opts.linkedRef` fallback (left unset) — the shadow only
      // gets the remote's `db.major_version = 14` override (`--tmpfs` on PG<=14)
      // if the flag (not a fallback) actually resolved the "linked" ref.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          "[db]",
          "major_version = 17",
          "",
          "[remotes.staging]",
          `project_id = "flagflagflagflagflag"`,
          "",
          "[remotes.staging.db]",
          "major_version = 14",
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, { isLocal: false, diffSql: "create table m ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({
            from: Option.some("linked"),
            to: Option.some("migrations"),
            projectRef: Option.some("flagflagflagflagflag"),
          }),
        );
        expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
        expect(s.explicitDiffCalls[0]?.desired).toEqual({
          kind: "migrations",
          projectRef: "flagflagflagflagflag",
        });
        expect(s.cache.cachedRef).toBe("flagflagflagflagflag");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "explicit --from local --to migrations --linked --project-ref proceeds and applies the flag ref's remote override",
    () => {
      // Same `[remotes.staging]` fixture as the `--from linked` case above, but here
      // it's a changed `--linked` (not a "linked" ref on either side) that resolves the
      // flag ref via the preflight — `preflightConnType` keys off
      // `Option.isSome(flags.linked)`, so the guard must not fire and the preflight's
      // resolved ref must still drive the `[remotes.<ref>]` merge below.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          "[db]",
          "major_version = 17",
          "",
          "[remotes.staging]",
          `project_id = "flagflagflagflagflag"`,
          "",
          "[remotes.staging.db]",
          "major_version = 14",
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, { isLocal: false, diffSql: "create table m ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({
            from: Option.some("local"),
            to: Option.some("migrations"),
            linked: Option.some(true),
            projectRef: Option.some("flagflagflagflagflag"),
          }),
        );
        expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
        expect(s.explicitDiffCalls[0]?.desired).toEqual({
          kind: "migrations",
          projectRef: "flagflagflagflagflag",
        });
        expect(s.cache.cachedRef).toBe("flagflagflagflagflag");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "explicit --from local --to migrations --project-ref errors (neither side is linked)",
    () => {
      // Neither side of the explicit cascade is the literal ref "linked", so the
      // flag would go unused — the guard fires instead of silently discarding it.
      const FLAG_REF = "flagflagflagflagflag";
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyDbDiff(
            flags({
              from: Option.some("local"),
              to: Option.some("migrations"),
              projectRef: Option.some(FLAG_REF),
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked, or --from/--to linked, in explicit mode",
        );
        expect(s.resolverCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // The project ref is cached the moment it's known, and stays cached even when a
      // LATER step (here, `legacyReadDbToml`'s own config-load) fails afterward.
      // `db.migrations.enabled = "notabool"` fails `legacyReadDbToml`'s own bool
      // parse AFTER the ref is already known, exercising exactly that gap.
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
    "migra provisions a local-target declarative shadow and diffs against the override database",
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

  it.effect(
    "diffs with the native pgAdmin engine: shadow create/rm, one differ run, no Go proxy call",
    () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        // --use-pgadmin no longer delegates to the bundled Go binary.
        expect(s.proxyCalls).toEqual([]);
        expect(s.proxyCaptureCalls).toEqual([]);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        expect(s.differCalls).toHaveLength(1);
        // Status lines go to STDOUT, not stderr.
        expect(stdout(s.out)).toBe(
          `Creating shadow database...\nDiffing local database with current migrations...\n${PGADMIN_DIFF_SQL}\n`,
        );
        // Stderr still carries the SHARED shadow-setup diagnostics (revoke-api-privileges,
        // roles.sql seeding — identical on every diff engine), but none of pgAdmin's own
        // status lines, which are on stdout instead, and none of the migra/pg-delta-only
        // "Diffing schemas..."/"Finished ... on branch" lines (`diff.Run`-only, bypassed).
        const err = stderr(s.out);
        expect(err).not.toContain("Creating shadow database...");
        expect(err).not.toContain("Diffing local database with current migrations...");
        expect(err).not.toContain("Diffing schemas");
        expect(err).not.toContain("Finished");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("rejects --project-ref combined with --use-pg-schema before delegating", () => {
    // The bundled Go binary's own `db diff` never registered `--project-ref`, so
    // the flag can't be forwarded — fail up front instead of silently dropping it.
    // (`--use-pgadmin` is native as of CLI-1968 and honors the flag — see the
    // positive test below.)
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbDiff(flags({ usePgSchema: Option.some(true), projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("--project-ref is not supported with --use-pg-schema");
      expect(s.proxyCalls).toEqual([]);
      expect(s.proxyCaptureCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pgadmin --linked honors --project-ref like the other native engines", () => {
    // CLI-1968 made pgadmin share the same target resolve as migra/pg-delta, so
    // the flag ref must win over the workdir's own linked ref here too.
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      pgadminStdout: [JSON.stringify([pgadminEntry()])],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          usePgAdmin: Option.some(true),
          linked: Option.some(true),
          projectRef: Option.some(FLAG_REF),
        }),
      );
      expect(s.proxyCalls).toEqual([]);
      expect(s.differCalls).toHaveLength(1);
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--use-pgadmin --linked succeeds when only the [remotes.<ref>] override fixes an invalid base config",
    () => {
      // pgadmin now shares the SAME target resolve as migra/pg-delta, so it validates
      // the remote-merged config, prints the override line, and succeeds — unlike the
      // old Go-delegate era, where the whole command (config load included) ran
      // inside the delegated child.
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
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
        expect(stderr(s.out)).toContain("Loading config override: [remotes.staging]");
        expect(s.proxyCalls).toEqual([]);
        expect(s.differCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pgadmin --linked's preflight probe targets the resolved LINKED project id, not the base config's",
    () => {
      // The preflight probe's project id derives from the resolved config AFTER the
      // linked remote merge, NOT the base config's own `project_id` — the matched
      // `[remotes.<ref>]` block's own `project_id` must suppress it.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          'project_id = "test"',
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
        // `mockLegacyShadowContainerCliSpawner` distinguishes this SEPARATE
        // `legacyIsLocalDbRunning` preflight probe from the shadow's own (64-hex-id)
        // health-check inspect by the `supabase_db_` container-name prefix.
        const inspectTargets = s.shadowSpawned
          .filter((c) => c.args[0] === "container" && c.args[1] === "inspect")
          .map((c) => c.args[2]);
        expect(inspectTargets).toContain("supabase_db_abcdefghijklmnopqrst");
        expect(inspectTargets).not.toContain("supabase_db_test");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pgadmin fails on an invalid base config when no [remotes.<ref>] override exists (parity with the native local path)",
    () => {
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.resolverCalls).toHaveLength(0);
        expect(s.differCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a native local diff still validates the base config", () => {
    // Control for the delegate case: the local/db-url native path reads the base
    // config (no remote merge), so an invalid base value (db.major_version=16) must
    // still fail.
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
      // config error only `legacyBuildLocalDbContainerInputs`'s own validation catches, and
      // it must run strictly before `resolver.resolve()` ever runs — so `resolverCalls`
      // must stay empty here, proving the shadow's config validation ran first, not just
      // that the command failed.
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
        expect(error).toBeInstanceOf(LegacyDbConfigLoadError);
        if (error instanceof LegacyDbConfigLoadError) {
          expect(error.message).toContain("failed to read TLS cert");
        }
        expect(s.resolverCalls).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("re-quotes a comma-containing schema when delegating --use-pg-schema", () => {
    // flags.schema holds the single parsed value `tenant,one`; forwarding it raw
    // would let the Go child's pflag StringSlice CSV-split it into two schemas, so
    // it must be re-encoded as a quoted CSV field. `--use-pg-schema` is the only
    // remaining delegate path.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgSchema: Option.some(true), schema: ["tenant,one"] }));
      const args = s.proxyCalls[0]?.args ?? [];
      const idx = args.indexOf("--schema");
      expect(args[idx + 1]).toBe('"tenant,one"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "forwards a comma-containing --schema value to the differ raw, with no CSV re-quoting (native path)",
    () => {
      // Unlike the --use-pg-schema delegate above, the native differ argv is never
      // re-parsed by a pflag StringSlice, so the single parsed value reaches the
      // container unchanged.
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), schema: ["tenant,one"] }));
        const call = s.differCalls[0];
        const idx = call?.cmd.indexOf("--schema") ?? -1;
        expect(call?.cmd[idx + 1]).toBe("tenant,one");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "delegates --use-pg-schema to the Go binary, printing a deprecation warning without duplicating Go's own warning",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgSchema: Option.some(true) }));
        // The TS wrapper prints its own deprecation notice pointing at pg-delta /
        // the default migra engine, additive to (not a replacement for) the
        // delegated Go child's own "experimental" warning (unchanged, printed by
        // the real Go binary rather than this mocked proxy). Assert on a stable
        // substring so future wording tweaks don't require touching every test site.
        expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
        // The TS wrapper must not print a second copy of the delegated child's own warning.
        expect(stderr(s.out)).not.toContain("--use-pg-schema flag is experimental");
        // Delegation to Go is unchanged besides the new warning.
        expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema"]);
        // The child's own telemetry is disabled so the single `cli_command_executed`
        // event comes from this TS command's instrumentation, not the delegated child.
        expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("does not print the --use-pg-schema deprecation warning on other diff paths", () => {
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "does not print the --use-pg-schema deprecation warning on the native --use-pgadmin path",
    () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "emits a json envelope for --use-pgadmin with status lines redirected to stderr (payload-only stdout)",
    () => {
      const s = setup(tmp.current, {
        format: "json",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        // stdout stays payload-only in machine mode — no status lines leak into it.
        expect(stdout(s.out)).toBe("");
        // The status lines are diagnostics, not payload, so machine mode redirects
        // them to stderr instead of dropping them (repo invariant: stdout is
        // payload-only, diagnostics go to stderr — CLI-1546).
        const err = stderr(s.out);
        expect(err).toContain("Creating shadow database...");
        expect(err).toContain("Diffing local database with current migrations...");
        expect(s.proxyCalls).toEqual([]);
        expect(s.proxyCaptureCalls).toEqual([]);
        const success = s.out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          diff: PGADMIN_DIFF_SQL,
          file: null,
          files: [],
          schemas: [],
          engine: "pgadmin",
          dropStatements: [],
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a json-mode --use-pgadmin --file reports the written migration path instead of null (regression vs the old delegate)",
    () => {
      const s = setup(tmp.current, {
        format: "json",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }),
        );
        const success = s.out.messages.find((m) => m.type === "success");
        const data = success?.data as { file: string; files: ReadonlyArray<string> };
        expect(data.file).toMatch(/\d{14}_pgadmin_diff\.sql$/);
        expect(data.files).toEqual([data.file]);
        expect(existsSync(data.file)).toBe(true);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("delivers the pgadmin payload as a stream-json result event too", () => {
    const s = setup(tmp.current, {
      format: "stream-json",
      pgadminStdout: [JSON.stringify([pgadminEntry()])],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ diff: PGADMIN_DIFF_SQL, engine: "pgadmin" });
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
      // The deprecation notice is a diagnostic, so it must still reach stderr in
      // machine output mode rather than being dropped or leaking into the stdout
      // payload.
      expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
      // The child's own telemetry is disabled here too, same as the text-mode delegate.
      expect(s.proxyCaptureCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes live-only SQL with --file even when declarative targets are configured", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["schemas/*.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "declarative.sql"),
      "create table declarative_only ();\n",
    );
    const s = setup(tmp.current, {
      pgDeltaImplementation: "next",
      diffSql: "create table live_only ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(stdout(s.out)).toBe("");
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
      expect(stderr(s.out)).toContain("-f names the migration; it does not filter objects");
      expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_my_diff\.sql$/);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("create table live_only ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("includes the ignored declarative baseline advisory in JSON output", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "items.sql"),
      "create table items ();\n",
    );
    const s = setup(tmp.current, {
      format: "json",
      pgDeltaImplementation: "next",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }),
      );
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table dogfood_note ();\n",
        engine: "pg-delta",
        advisories: [
          {
            code: "DeclarativeSchemaNotUsedAsDiffBaseline",
            severity: "info",
            context: {
              baseline: "supabase/migrations",
              declarativePath: "supabase/schemas",
              fileFlagFiltersObjects: false,
            },
          },
        ],
      });
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("ignores declarative inspection errors without changing diff success", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "not-a-directory.sql"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "not-a-directory.sql"), "select 1;\n");
    const s = setup(tmp.current, {
      format: "json",
      pgDeltaImplementation: "next",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }),
      );
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).not.toHaveProperty("advisories");
      expect(success?.data).toMatchObject({ diff: "create table dogfood_note ();\n" });
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes one migration file per unit for a multi-unit pg-delta plan", () => {
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "ignored", sql: "alter type mood add value 'ok';" },
        { name: "ignored", sql: "insert into t values ('ok');" },
      ],
      diffSuffixes: ["_1", "_2"],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toBe("19700101000000_my_diff_1.sql");
      expect(files[1]).toBe("19700101000001_my_diff_2.sql");
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("alter type mood add value 'ok';\n");
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { file: string; files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      expect(data.file).toBe(data.files[0]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested single-unit --file name", () => {
    // `db diff -f snapshots/remote` must create the `<ts>_snapshots/` parent dir
    // before writing.
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

  it.effect("explicit --from local --to linked prints the diff to stdout", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("local"), to: Option.some("linked") }));
      // Explicit mode is pg-delta and never provisions a shadow.
      expect(s.explicitDiffCalls[0]).toMatchObject({
        source: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            user: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
        desired: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: false, dnsResolver: "native" },
        },
      });
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
      expect(stdout(s.out)).toBe("create table e ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit URL endpoints retain the raw ref and remote connection options", () => {
    const s = setup(tmp.current, { diffSql: "create table u ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("postgresql://source.example/postgres"),
          to: Option.some("postgresql://desired.example/postgres"),
        }),
      );
      expect(s.explicitDiffCalls[0]?.source).toEqual({
        kind: "database",
        ref: "postgresql://source.example/postgres",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "database",
        ref: "postgresql://desired.example/postgres",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
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

  it.effect(
    "forwards an explicit --linked=false target flag to the delegated pg-schema child",
    () => {
      // Target flags are selectors keyed on flag.Changed in the delegated Go child;
      // dropping Some(false) would make the child default to local instead of the
      // linked target the native path selected. `--use-pg-schema` is the only
      // remaining delegate path.
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgSchema: Option.some(true), linked: Option.some(false) }));
        expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema", "--linked=false"]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an empty --file value prints to stdout instead of writing a nameless migration",
    () => {
      // The file write is gated on the value being non-empty; an empty --file
      // (e.g. an unset shell var) falls through to stdout rather than writing
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
      // The file write is gated on the value being non-empty; an empty value falls
      // through to stdout rather than writing SQL into the project directory.
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

  it.effect("explicit --from migrations routes the migrations endpoint to the strategy", () => {
    const s = setup(tmp.current, { diffSql: "create table m ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("local") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from linked --to migrations passes the linked ref to the strategy", () => {
    // Go resolves linked first (LoadConfig merges [remotes.<ref>]), so the later
    // migrations catalog is built from the remote-merged config (explicit.go).
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
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("linked"), to: Option.some("migrations") }));
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
      // Opposite direction of the sibling "migrations --to linked" test below: linked
      // resolves FIRST here, so the remote-merged config (major_version = 14) is what
      // must reach the migrations shadow/catalog.
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from migrations --to linked passes base config to the strategy", () => {
    // Migrations is resolved BEFORE linked here, so Go's LoadConfig(ref) hasn't run
    // yet — the catalog (and its shadow's own container spec) must use base config
    // (no ref forwarded), matching order.
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
        // Set ONLY under the remote block: proves the strategy-received toml is the
        // base config, not the linked-merged one (which would flip this to true).
        "[remotes.staging.experimental.webhooks]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("linked") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(17);
      expect(s.explicitDiffCalls[0]?.toml?.webhooksEnabled).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked seeds the merged config", () => {
    // A changed --linked resolves the project ref and remote-merges the config
    // before the explicit refs resolve — so the migrations catalog's shadow (and
    // local refs/format options) use the linked override even though neither
    // explicit ref is itself `linked`.
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
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked validates the merged config", () => {
    // The explicit base config read is deferred until after the linked preflight, so
    // a base config that's only valid after the [remotes.<ref>] merge (base
    // major_version=16, override=15) does not fail before the ref is resolved.
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

  it.effect("warns on semantic data-loss hazards without a DROP statement", () => {
    const sql = "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;";
    const s = setup(tmp.current, {
      pgDeltaImplementation: "next",
      diffSql: sql,
      hazards: {
        actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
        dataLoss: [{ actionIndex: 0, sql }],
        coverage: ["data_loss"],
        kinds: ["data_loss"],
      },
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(stderr(s.out)).toContain("Found destructive changes in schema diff");
      expect(stderr(s.out)).toContain(sql);
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

  it.effect("surfaces a crashed migra script instead of reporting no schema changes", () => {
    const s = setup(tmp.current, {
      diffFailWith:
        "error diffing schema: error running script:\nTypeError: Cannot read properties of undefined (reading 'constraints')\nPGDELTA_SCRIPT_ERROR\n",
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stderr(s.out)).not.toContain("No schema changes found");
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
    // The migra OOM bash fallback routes through Docker start, which overrides the
    // requested host network with --network-id when set.
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
      // swallowed until the health check gave up on its own. `acquire` is now ONLY
      // `legacyCreateShadowDatabase`
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

  describe("--use-pgadmin (native differ, CLI-1968)", () => {
    it.effect(
      "prints 'No schema changes found' and writes nothing when the differ output is empty",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [""] });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).toContain("No schema changes found");
          expect(stdout(s.out)).toBe(
            "Creating shadow database...\nDiffing local database with current migrations...\n",
          );
          const migrationsDir = join(tmp.current, "supabase", "migrations");
          expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "prints 'No schema changes found' when every diff entry is filtered out (all Identical)",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ status: "Identical" })])],
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).toContain("No schema changes found");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("writes a timestamped migration for --use-pgadmin --file instead of printing", () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }),
        );
        expect(stdout(s.out)).not.toContain("ALTER TABLE");
        expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
        const dir = join(tmp.current, "supabase", "migrations");
        const files = readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{14}_pgadmin_diff\.sql$/);
        expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(PGADMIN_DIFF_SQL);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("creates nested parent directories for a nested --use-pgadmin --file name", () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("snapshots/remote") }),
        );
        const migrationsRoot = join(tmp.current, "supabase", "migrations");
        const dirs = readdirSync(migrationsRoot);
        expect(dirs).toHaveLength(1);
        expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
        expect(readdirSync(join(migrationsRoot, dirs[0]!))).toEqual(["remote.sql"]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "an empty --use-pgadmin --file value falls through to stdout instead of writing",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), file: Option.some("") }));
          expect(stdout(s.out)).toContain("ALTER TABLE test;");
          const migrationsDir = join(tmp.current, "supabase", "migrations");
          expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "never prints the 'Finished ... on branch' banner or a drop-statement warning, even with a DROP in the SQL",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ diff_ddl: "drop table gone;" })])],
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).not.toContain("Finished");
          expect(stderr(s.out)).not.toContain("Found drop statements");
          expect(stdout(s.out)).toContain("drop table gone;");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "invokes the differ with the exact argv, image, network, labels, and empty env/binds (no --schema)",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        // `LegacyCliConfig.projectId` only feeds pg-delta's own project id (a
        // SEPARATE mechanism); the shadow/differ's docker network+labels come from
        // `legacyLoadLocalProjectContext`'s REAL resolution (no config.toml
        // `project_id`/`SUPABASE_PROJECT_ID` here), which falls back to the workdir
        // basename — same as the pg-delta Deno-cache-volume tests above.
        const projectId = basename(tmp.current);
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(s.differCalls).toHaveLength(1);
          const call = s.differCalls[0] as LegacyDockerRunOpts;
          expect(call.image).toBe(dockerfileServiceImage("differ"));
          expect(call.image).toBe("supabase/pgadmin-schema-diff:cli-0.0.5");
          expect(call.cmd).toEqual(["--json-diff", PGADMIN_SOURCE_URL, PGADMIN_TARGET_URL]);
          expect(call.env).toEqual({});
          expect(call.binds).toEqual([]);
          expect(call.securityOpt).toEqual([]);
          expect(call.workingDir).toEqual(Option.none());
          expect(call.entrypoint).toBeUndefined();
          expect(call.network).toEqual({ _tag: "named", name: `supabase_network_${projectId}` });
          expect(call.labels).toEqual({
            "com.supabase.cli.project": projectId,
            "com.docker.compose.project": projectId,
          });
          expect(call.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
          // Go never tees the differ's raw stderr to the parent terminal — the
          // `runCapture` options argument must stay unset.
          expect(s.differCaptureOpts[0]).toBeUndefined();
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--network-id forwards to the differ's --network, same as the shadow", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
        networkId: "custom-net",
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        const call = s.differCalls[0] as LegacyDockerRunOpts;
        expect(call.network).toEqual({ _tag: "named", name: "custom-net" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "omits --add-host on a non-Linux host (Go's docker_darwin.go/docker_windows.go)",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
          platform: "darwin",
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          const call = s.differCalls[0] as LegacyDockerRunOpts;
          expect(call.extraHosts).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "hardcodes the shadow target's postgres:postgres credentials, ignoring a configured [db] password (Go pgadmin.go quirk)",
      () => {
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", "config.toml"),
          '[db]\npassword = "distinctive-pw"\n',
        );
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          const call = s.differCalls[0] as LegacyDockerRunOpts;
          expect(call.cmd.at(-1)).toBe(PGADMIN_TARGET_URL);
          expect(call.cmd.join(" ")).not.toContain("distinctive-pw");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "a supabase/.env-only SUPABASE_INTERNAL_IMAGE_REGISTRY reaches the differ's image resolver during the run, and reverts after",
      () => {
        // `legacyDockerRunLayer`'s own image resolver has no `projectEnvValues` in
        // scope, so it falls back to reading `process.env` directly at `runCapture`
        // call time; this mock docker layer records that same read
        // (`differRegistryEnvAtCall`) since it replaces the real resolver wholesale
        // and can't observe an already-rewritten image.
        const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", ".env"),
          "SUPABASE_INTERNAL_IMAGE_REGISTRY=registry.example.com\n",
        );
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(s.differRegistryEnvAtCall).toEqual(["registry.example.com"]);
          // Reverted once the handler's scope closes — no leak into a later command
          // (or a later test) sharing this process.
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
              else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = prev;
            }),
          ),
          Effect.provide(s.layer),
        );
      },
    );

    it.effect(
      "filters differ stderr through ProcessDiffProgress, printing only the matched status text to stdout",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
          pgadminStderr: [
            "Starting schema diff...\nComparing Tables 45%\nnoise line\nDiffing 100%\n",
          ],
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
          const text = stdout(s.out);
          expect(text).toContain("Comparing Tables \n");
          expect(text).toContain("Diffing 1\n");
          expect(text).not.toContain("Starting schema diff...");
          expect(text).not.toContain("noise line");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("still parses --json-diff output prefixed with the DESKTOP-mode NOTE line", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [`${LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry()])}`],
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stdout(s.out)).toContain("ALTER TABLE test;");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "loops one differ run per --schema, in flag order, with per-run 'Diffing schema:' status lines",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ diff_ddl: "create table pub ();" })]), ""],
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), schema: ["public", "app"] }));
          expect(s.differCalls).toHaveLength(2);
          expect((s.differCalls[0] as LegacyDockerRunOpts).cmd).toEqual([
            "--schema",
            "public",
            "--json-diff",
            PGADMIN_SOURCE_URL,
            PGADMIN_TARGET_URL,
          ]);
          expect((s.differCalls[1] as LegacyDockerRunOpts).cmd).toEqual([
            "--schema",
            "app",
            "--json-diff",
            PGADMIN_SOURCE_URL,
            PGADMIN_TARGET_URL,
          ]);
          const text = stdout(s.out);
          const idxPublic = text.indexOf("Diffing schema: public");
          const idxApp = text.indexOf("Diffing schema: app");
          expect(idxPublic).toBeGreaterThanOrEqual(0);
          expect(idxApp).toBeGreaterThan(idxPublic);
          expect(text).toContain("create table pub ();");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      ">=2 --schema runs each emitting a diff array succeed, aggregating every run's DDL under ONE header (CLI-1968 round 2: parsed per run, not concatenated then parsed once)",
      () => {
        // Completes the intended shared-buffer algorithm's own purpose (see
        // `legacy-pgadmin-diff.ts`'s own header comment): each run's stdout is
        // parsed on its own, so >=2 `--schema` runs that each emit a full JSON
        // array no longer concatenate into one buffer and fail a single
        // `JSON.parse` — every run's own DESKTOP-mode NOTE prefix (`pgadmin4#24`)
        // is trimmed from that run's own buffer too, not just the very first run's.
        const s = setup(tmp.current, {
          pgadminStdout: [
            `${LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry({ diff_ddl: "create table pub ();" })])}`,
            `${LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry({ diff_ddl: "create table app ();" })])}`,
          ],
        });
        return Effect.gen(function* () {
          yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), schema: ["public", "app"] }));
          const text = stdout(s.out);
          // A single header, not one per run.
          expect(text.split(LEGACY_PGADMIN_DIFF_HEADER)).toHaveLength(2);
          expect(text).toContain(
            `${LEGACY_PGADMIN_DIFF_HEADER}\n\ncreate table pub ();\n\ncreate table app ();\n`,
          );
          // Per-run "Diffing schema:" ordering is preserved.
          const idxPublic = text.indexOf("Diffing schema: public");
          const idxApp = text.indexOf("Diffing schema: app");
          expect(idxPublic).toBeGreaterThanOrEqual(0);
          expect(idxApp).toBeGreaterThan(idxPublic);
          // Neither run's raw NOTE prefix leaked into the rendered diff.
          expect(text).not.toContain("NOTE: Configuring authentication for DESKTOP mode.");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails with invalid_output when a run's own --json-diff stdout doesn't parse", () => {
      const s = setup(tmp.current, { pgadminStdout: ["not valid json"] });
      return Effect.gen(function* () {
        const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "LegacyDbDiffPgAdminError",
          reason: "invalid_output",
        });
        expect((error as { message: string }).message).toContain(
          "failed to parse schema diff output:",
        );
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "emits a failed run's captured progress statuses before the container-error surfaces",
      () => {
        // This port batches stderr via `runCapture` instead of streaming it, so a
        // run that later exits non-zero must still have its captured status lines
        // processed/emitted BEFORE the exit-code check, not after returning early.
        const s = setup(tmp.current, {
          pgadminExitCode: 1,
          pgadminStderr: ["Comparing Tables 45%\nDiffing 100%\n"],
        });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({
            _tag: "LegacyDbDiffPgAdminError",
            reason: "differ",
            message: "error running container: exit 1",
          });
          const text = stdout(s.out);
          expect(text).toContain("Comparing Tables \n");
          expect(text).toContain("Diffing 1\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "in stream-json mode, a failed run's captured progress statuses redirect to stderr (CLI-1546) but are still emitted before the container-error result",
      () => {
        const s = setup(tmp.current, {
          format: "stream-json",
          pgadminExitCode: 1,
          pgadminStderr: ["Comparing Tables 45%\n"],
        });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ _tag: "LegacyDbDiffPgAdminError", reason: "differ" });
          expect(stderr(s.out)).toContain("Comparing Tables \n");
          expect(stdout(s.out)).toBe("");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'error running container: exit 1' when the differ exits non-zero, and still removes the shadow",
      () => {
        const s = setup(tmp.current, {
          pgadminExitCode: 1,
          pgadminStderr: ["some differ crash text\n"],
        });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({
            _tag: "LegacyDbDiffPgAdminError",
            reason: "differ",
            message: "error running container: exit 1",
          });
          // The differ's own stderr never reaches the error message (Go quirk — it
          // only ever fed the progress-line filter).
          expect((error as { message: string }).message).not.toContain("some differ crash text");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails with 'error running container: exit 137' on an OOM-killed differ", () => {
      const s = setup(tmp.current, { pgadminExitCode: 137 });
      return Effect.gen(function* () {
        const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "LegacyDbDiffPgAdminError",
          reason: "differ",
          message: "error running container: exit 137",
        });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("classifies a differ spawn failure as docker_daemon", () => {
      const s = setup(tmp.current, { pgadminDockerFail: "spawn" });
      return Effect.gen(function* () {
        const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "LegacyDbDiffPgAdminError", reason: "docker_daemon" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("classifies a differ image-pull failure as registry_pull", () => {
      const s = setup(tmp.current, { pgadminDockerFail: "pull" });
      return Effect.gen(function* () {
        const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "LegacyDbDiffPgAdminError", reason: "registry_pull" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'supabase start is not running.' before ever creating a shadow, but after the target resolve",
      () => {
        const s = setup(tmp.current, { dbNotRunning: true });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ _tag: "LegacyDbDiffDbNotRunningError" });
          expect(stripAnsi((error as { message: string }).message)).toBe(
            "supabase start is not running.",
          );
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
          expect(s.differCalls).toEqual([]);
          // The target was still resolved BEFORE the running-check failed — Go
          // resolves the target in the root PersistentPreRunE, strictly before
          // RunPgAdmin's AssertSupabaseDbIsRunning.
          expect(s.resolverCalls.length).toBeGreaterThan(0);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "classifies a daemon-unreachable local-db inspect as daemonDown with the Docker install suggestion",
      () => {
        const s = setup(tmp.current, {
          dbInspectFailsWith:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ _tag: "LegacyDbDiffDbNotRunningError", daemonDown: true });
          expect((error as { suggestion?: string }).suggestion).toContain("Docker Desktop");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "propagates a failed shadow platform-baseline job and still removes the shadow (pgAdmin path)",
      () => {
        const s = setup(tmp.current, { failShadowSetupJob: true });
        return Effect.gen(function* () {
          const exit = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with LegacyDbDiffWriteError when writing the pgAdmin --file migration fails",
      () => {
        // Shadow setup writes the branch marker and `revoke-api-privileges.sql`
        // before the command writes the pgAdmin migration, so call #3 is the
        // diff-file write exercised here.
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
          failWriteOnCall: 3,
        });
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(
            flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "LegacyDbDiffWriteError" });
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails on engine-flag conflict (--use-pgadmin with --use-pg-delta), byte-exact cobra message",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const error = yield* legacyDbDiff(
            flags({ usePgAdmin: Option.some(true), usePgDelta: Option.some(true) }),
          ).pipe(Effect.flip);
          expect((error as { message: string }).message).toBe(
            "if any flags in the group [use-migra use-pgadmin use-pg-schema use-pg-delta] are set none of the others can be; [use-pg-delta use-pgadmin] were all set",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails on target mutex when --use-pgadmin is combined with --linked and --local",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const exit = yield* legacyDbDiff(
            flags({
              usePgAdmin: Option.some(true),
              linked: Option.some(true),
              local: Option.some(true),
            }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "explicit --from/--to wins over --use-pgadmin (pgadmin is ignored, pg-delta runs)",
      () => {
        const s = setup(tmp.current, { isLocal: false, diffSql: "create table explicit ();\n" });
        return Effect.gen(function* () {
          yield* legacyDbDiff(
            flags({
              usePgAdmin: Option.some(true),
              from: Option.some("local"),
              to: Option.some("linked"),
            }),
          );
          expect(s.differCalls).toEqual([]);
          expect(s.explicitDiffCalls).toHaveLength(1);
          expect(stdout(s.out)).toBe("create table explicit ();\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.live(
      "removes the shadow container on interruption during the health wait for --use-pgadmin too",
      () => {
        const s = setup(tmp.current, { neverHealthyShadow: true });
        return Effect.gen(function* () {
          const fiber = yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.provide(s.layer),
            Effect.forkChild({ startImmediately: true }),
          );
          // Wait for the SHADOW's own health probe specifically (its 64-hex id) —
          // the pgadmin path's separate `supabase_db_test` "is running" probe fires
          // first and would otherwise satisfy a looser check immediately.
          while (
            !s.shadowSpawned.some(
              (c) =>
                c.args[0] === "container" &&
                c.args[1] === "inspect" &&
                c.args[2] === LEGACY_FAKE_SHADOW_CONTAINER_ID,
            )
          ) {
            yield* Effect.sleep("5 millis");
          }
          yield* Fiber.interrupt(fiber);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.differCalls).toEqual([]);
        });
      },
    );
  });
});
