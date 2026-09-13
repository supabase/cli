import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  VALID_REF,
  withEnvVar,
  mockCommandSettings,
  mockDockerDaemonCliSpawner,
  mockLinkedProjectCacheTracked,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  useShadowCacheDisabled,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScriptError } from "../../../command-internal/edge-runtime-script.errors.ts";
import {
  type EdgeRuntimeRunOpts,
  EdgeRuntimeScript,
} from "../../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../shared/pgdelta-engine.service.ts";
import { dbRemoteCommit } from "../remote/commit/commit.handler.ts";
import type { DbRemoteCommitFlags } from "../remote/commit/commit.command.ts";
import type { DbPullFlags } from "./pull.command.ts";
import { dbPull } from "./pull.handler.ts";
import { runDbPull } from "../../../command-internal/db-pull-run.ts";

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [{ path: "schemas/public/t.sql", order: 0, statements: 1, sql: "create table t ();" }],
});

// Builds the pg-delta diff envelope: one file per plan unit.
const pgDeltaDiffEnvelope = (
  units: ReadonlyArray<{ name: string; sql: string; transactionMode?: string }>,
): string =>
  JSON.stringify({
    version: 1,
    files: units.map((unit, index) => ({
      order: index + 1,
      name: unit.name,
      transactionMode: unit.transactionMode ?? "transactional",
      sql: unit.sql,
    })),
  });

interface SetupOpts {
  readonly nextDebugDirectory?: string;
  readonly format?: OutputFormat;
  readonly remoteVersions?: ReadonlyArray<string>;
  readonly edgeStdout?: string; // diff SQL or declarative export JSON
  readonly stdinIsTty?: boolean;
  // Piped (non-TTY) stdin answers, one consumed per confirmation prompt.
  readonly pipedAnswers?: ReadonlyArray<string>;
  readonly yes?: boolean;
  readonly experimental?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly resolvedRef?: string;
  // Fails the first edge-runtime run with this message (the second succeeds with
  // `edgeStdout`), to exercise the pooler-fallback retry.
  readonly edgeFailFirstWith?: string;
  // `resolvePoolerFallback` returns `Some(pooler conn)` when true, `None` otherwise.
  readonly poolerAvailable?: boolean;
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
  // Initial-migra pull: the bytes the native pg_dump container streams to its sink, its
  // exit code/stderr, and (when set) an IPv6 stderr that fails the first dump attempt so
  // the pooler retry runs (the second attempt then streams `dumpStdout`).
  readonly dumpStdout?: string;
  readonly dumpExitCode?: number;
  readonly dumpStderr?: string;
  readonly dumpFailFirstWith?: string;
  // Bytes the first dump attempt streams before failing with `dumpFailFirstWith`.
  readonly dumpFailFirstPartialBytes?: string;
  // Raw argv seen by the handler (CliArgs). Only consulted when both `--declarative`
  // and `--use-pg-delta` are present, to replay pflag's last-occurrence-wins ordering.
  readonly args?: ReadonlyArray<string>;
  // `CommandSettings.projectId`; defaults to `Option.some("test")`. Pass
  // `Option.none()` to exercise the config.toml/workdir-basename fallback
  // (`resolveLocalProjectId`).
  readonly projectId?: Option.Option<string>;
  // Simulates an unlinked workdir: `loadProjectRef` fails with
  // `ProjectRefNotLinkedError` absent an explicit `--project-ref` flag.
  readonly linkedFails?: boolean;
  // Swaps in the stateful Docker model (real `stop`/`cp`/`start`), required by the
  // shadow baseline cache tests.
  readonly statefulDocker?: boolean;
  // Fails the target session's own history upsert (the write `updateMigrationHistory`
  // issues after the migration file is already on disk); the shadow's own internal
  // migration replay is unaffected. Exercises `DbPullWriteError`'s `writtenSoFar`.
  readonly historyUpdateFailWith?: string;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  // A real docker-spawner fake backs container create/start/health-inspect/cleanup.
  const shadowSpawner = mockShadowContainerCliSpawner();
  // Cache tests need the stateful Docker model since `docker cp` needs real container state.
  const dockerDaemon = opts.statefulDocker === true ? mockDockerDaemonCliSpawner() : undefined;

  const engineCalls: Array<{
    operation: "diff" | "export";
    targetRef: string;
    projectRef?: string;
    projectId: string;
    strictCoverage: boolean;
  }> = [];
  let engineDiffCount = 0;
  const pgDeltaEngine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
      diffExplicit: () => Effect.die("diffExplicit unused"),
      diffDatabase: (input) => {
        engineCalls.push({
          operation: "diff",
          targetRef: input.target.ref,
          projectRef: input.projectRef,
          projectId: input.context.projectId,
          strictCoverage: input.strictCoverage,
        });
        engineDiffCount += 1;
        if (opts.edgeFailFirstWith !== undefined && engineDiffCount === 1) {
          return Effect.fail(
            new PgDeltaEngineError({
              message: opts.edgeFailFirstWith,
              cause: opts.edgeFailFirstWith,
            }),
          );
        }
        const stdout = opts.edgeStdout ?? "";
        if (stdout.trim().length === 0) {
          return Effect.succeed({
            changes: false,
            sql: "",
            files: [],
            ...(process.env["PGDELTA_DEBUG"] !== undefined
              ? {
                  debug:
                    opts.nextDebugDirectory !== undefined
                      ? { directory: opts.nextDebugDirectory }
                      : {},
                }
              : {}),
          });
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (typeof parsed !== "object" || parsed === null) throw new Error("invalid envelope");
          const rawFiles = Reflect.get(parsed, "files");
          if (!Array.isArray(rawFiles)) throw new Error("invalid envelope");
          const files = rawFiles.map((raw, index) => {
            if (typeof raw !== "object" || raw === null) throw new Error("invalid file");
            const sql = Reflect.get(raw, "sql");
            const name = Reflect.get(raw, "name");
            const transactionMode = Reflect.get(raw, "transactionMode");
            if (typeof sql !== "string" || typeof name !== "string") {
              throw new Error("invalid file");
            }
            if (transactionMode !== "transactional" && transactionMode !== "none") {
              throw new Error(`unknown transaction mode ${String(transactionMode)}`);
            }
            return {
              sequence: index + 1,
              name,
              sql,
              transactionMode,
            };
          });
          return Effect.succeed({
            changes: files.length > 0,
            sql: files.map((file) => file.sql).join("\n"),
            files,
          });
        } catch (cause) {
          return Effect.fail(
            new PgDeltaEngineError({
              message: "failed to parse pg-delta diff output",
              cause,
            }),
          );
        }
      },
      exportDeclarativeSchema: (input) => {
        engineCalls.push({
          operation: "export",
          targetRef: input.target.ref,
          projectRef: input.projectRef,
          projectId: input.context.projectId,
          strictCoverage: input.strictCoverage,
        });
        if (opts.edgeFailFirstWith !== undefined && engineCalls.length === 1) {
          return Effect.fail(
            new PgDeltaEngineError({
              message: opts.edgeFailFirstWith,
              cause: opts.edgeFailFirstWith,
            }),
          );
        }
        return Effect.succeed({
          files: [{ name: "public/t.sql", sql: "create table t ();" }],
          manifest: {
            redactSecrets: true,
            scope: "database",
            profile: "supabase",
          },
        });
      },
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
    }),
  );

  let edgeRunCount = 0;
  const edgeCalls: EdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(EdgeRuntimeScript, {
    run: (runOpts: EdgeRuntimeRunOpts) => {
      edgeRunCount += 1;
      edgeCalls.push(runOpts);
      if (opts.edgeFailFirstWith !== undefined && edgeRunCount === 1) {
        return Effect.fail(new EdgeRuntimeScriptError({ message: opts.edgeFailFirstWith }));
      }
      return Effect.succeed({ stdout: opts.edgeStdout ?? "", stderr: "" });
    },
  });

  // The initial-migra pull seeds the migration via a native pg_dump `runStream`;
  // delivers configured bytes to `onStdout` then reports exit code + stderr.
  // `dumpFailFirstWith` fails the first attempt so the pooler retry runs.
  const dumpCalls: Array<{
    env: Readonly<Record<string, string>>;
    image: string;
    network: DockerRunOpts["network"];
  }> = [];
  let dumpRunCount = 0;
  const docker = Layer.succeed(DockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        // The shadow's own PG15+ one-shot jobs share this `runStream` but always set
        // `skipImageResolve: true`; succeed them unconditionally so they're never
        // counted alongside the real `dumpCalls` this suite asserts on.
        if (runOpts.skipImageResolve === true) {
          return { exitCode: 0, stderr: "" };
        }
        dumpRunCount += 1;
        dumpCalls.push({ env: runOpts.env, image: runOpts.image, network: runOpts.network });
        if (opts.dumpFailFirstWith !== undefined && dumpRunCount === 1) {
          if (opts.dumpFailFirstPartialBytes !== undefined) {
            const partial = new TextEncoder().encode(opts.dumpFailFirstPartialBytes);
            if (partial.length > 0) yield* streamOpts.onStdout(partial);
          }
          return { exitCode: 1, stderr: opts.dumpFailFirstWith };
        }
        const bytes = new TextEncoder().encode(opts.dumpStdout ?? "");
        if (bytes.length > 0) yield* streamOpts.onStdout(bytes);
        return { exitCode: opts.dumpExitCode ?? 0, stderr: opts.dumpStderr ?? "" };
      }),
  });

  const execLog: string[] = [];
  const historyUpserts: ReadonlyArray<unknown>[] = [];
  const connectedDatabases: Array<string> = [];
  /** Same connects as {@link connectedDatabases}, keeping the port that tells target from shadow apart. */
  const connectTargets: Array<{ readonly database: string; readonly port: number }> = [];
  // The resolver mock's target connection always dials port 5432; the shadow always
  // dials the schema-default shadow port (54320) instead — a reliable way to tell the
  // target's own history upsert (what `historyUpserts` counts) apart from the shadow's
  // internal migration replay, which issues the same parameterized query into its own
  // separate history table.
  const TARGET_PORT = 5432;
  const makeSession = (isShadow: boolean): DbSession => {
    const exec = (sql: string) => Effect.sync(() => void execLog.push(sql));
    const query = (sql: string, params?: ReadonlyArray<unknown>) => {
      if (/SELECT version/u.test(sql)) {
        return Effect.succeed((opts.remoteVersions ?? []).map((v) => ({ version: v })));
      }
      if (!isShadow && params !== undefined) {
        if (opts.historyUpdateFailWith !== undefined) {
          return Effect.fail(new DbExecError({ message: opts.historyUpdateFailWith }));
        }
        historyUpserts.push(params);
      }
      return Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
    };
    return {
      exec,
      query,
      // A migration batch carries exactly the statements (and the parameterized
      // history insert) the sequential path would run, so route each operation
      // through the same recording.
      execBatch: (statements) =>
        Effect.forEach(statements, ({ sql, params }) =>
          params === undefined ? exec(sql) : query(sql, params),
        ).pipe(Effect.asVoid),
      extensionExists: () => Effect.die("extensionExists unused"),
      copyToCsv: () => Effect.die("copyToCsv unused"),
      queryRaw: () => Effect.die("queryRaw unused"),
    };
  };
  const targetSession = makeSession(false);
  const shadowSession = makeSession(true);
  const dbConnection = Layer.succeed(DbConnection, {
    connect: (cfg: { readonly database: string; readonly port: number }) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        connectTargets.push({ database: cfg.database, port: cfg.port });
        return cfg.port === TARGET_PORT ? targetSession : shadowSession;
      }),
  });

  const poolerFallbackCalls: unknown[] = [];
  const resolveCalls: unknown[] = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (resolveFlags) => {
      resolveCalls.push(resolveFlags);
      const { connType } = resolveFlags;
      return Effect.succeed({
        conn: {
          // A direct `db.<ref>.<projectHost>` host so the pooler-fallback gate
          // matches on the linked path.
          host: connType === "local" ? "127.0.0.1" : "db.abcdefghijklmnopqrst.supabase.co",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: connType === "local",
        ref: opts.resolvedRef !== undefined ? Option.some(opts.resolvedRef) : Option.none(),
      });
    },
    resolvePoolerFallback: (resolveFlags) => {
      poolerFallbackCalls.push(resolveFlags);
      return Effect.succeed(
        opts.poolerAvailable === true
          ? Option.some({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 6543,
              user: "postgres",
              password: "x",
              database: "postgres",
            })
          : Option.none(),
      );
    },
  });

  const proxyCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const proxyCaptureCalls: Array<{
    args: ReadonlyArray<string>;
    env?: Record<string, string>;
    stdin?: "inherit" | "ignore";
  }> = [];
  const proxy = Layer.succeed(GoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        proxyCaptureCalls.push({ args, env: execOpts?.env, stdin: execOpts?.stdin });
        return opts.delegateStdout ?? "";
      }),
  });

  // Mirrors the same ref `resolver`'s own mock embeds above, and gives an explicit
  // `--project-ref` flag top precedence over `opts.resolvedRef` (mirrors
  // `reset.integration.test.ts`'s identical mock).
  const projectRefResolver = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.resolvedRef ?? VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed(opts.resolvedRef ?? VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
  });

  const baseLayer = Layer.mergeAll(
    // Listed first so the fake service layers below (`Layer.mergeAll` is last-wins)
    // override its real implementations, matching `start.integration.test.ts`.
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cache.layer,
    pgDeltaEngine,
    edge,
    docker,
    dbConnection,
    dockerDaemon?.layer ?? shadowSpawner.layer,
    alwaysReadyHttpClientLayer,
    resolver,
    projectRefResolver,
    proxy,
    mockCommandSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(
      opts.stdinIsTty ?? false,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(PgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockRuntimeInfo(),
  );
  return {
    layer: baseLayer,
    out,
    proxyCalls,
    proxyCaptureCalls,
    historyUpserts,
    execLog,
    connectedDatabases,
    connectTargets,
    poolerFallbackCalls,
    resolveCalls,
    dumpCalls,
    engineCalls,
    shadowSpawned: shadowSpawner.spawned,
    dockerDaemon,
    get edgeRunCount() {
      return edgeRunCount;
    },
    edgeCalls,
    cache,
  };
}

const flags = (over: Partial<DbPullFlags> = {}): DbPullFlags => ({
  name: over.name ?? Option.none(),
  declarative: over.declarative ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  diffEngine: over.diffEngine ?? Option.none(),
  strictCoverage: over.strictCoverage ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const commitFlags = (over: Partial<DbRemoteCommitFlags> = {}): DbRemoteCommitFlags => ({
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  password: over.password ?? Option.none(),
});

const streamText = (out: ReturnType<typeof mockOutput>, stream: "stdout" | "stderr") =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === stream)
      .map((c) => c.text)
      .join(""),
  );

const seedMigration = (workdir: string, version: string) => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${version}_local.sql`), "create table local ();\n");
};

const tmp = useTempWorkdir();
useShadowCacheDisabled();

describe("db pull", () => {
  it.effect("pulls a migration (pgdelta engine) and updates remote history under --yes", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([
        {
          name: "schema_changes",
          sql: "-- Migration unit 1: schema_changes\n\ncreate table remote ();",
        },
      ]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("pg-delta"), strictCoverage: true }));
      const dir = join(tmp.current, "supabase", "migrations");
      expect(existsSync(join(dir, `${"20240101000000"}_local.sql`))).toBe(true);
      const written = readdirSync(dir).filter((f) => f.endsWith("_remote_schema.sql"));
      expect(written).toHaveLength(1);
      expect(readFileSync(join(dir, written[0] ?? ""), "utf8")).toContain(
        "create table remote ();",
      );
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${join("supabase", "migrations", written[0] ?? "")}\n`,
      );
      expect(streamText(s.out, "stderr")).not.toContain(tmp.current);
      expect(s.historyUpserts.length).toBe(1);
      expect(s.engineCalls).toHaveLength(1);
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(s.engineCalls[0]?.strictCoverage).toBe(true);
      expect(s.edgeRunCount).toBe(0);
      expect(streamText(s.out, "stdout")).toContain("Finished supabase db pull.");
      // The linked ref is pre-loaded before `resolve()` runs, so the cache still gets
      // it, matching the `db reset`/`db push` pattern.
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pulls from the project given via --project-ref without a linked workdir", () => {
    // `linkedFails: true` simulates an unlinked workdir; only the flag can resolve a ref.
    const FLAG_REF = "flagflagflagflagflag";
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      projectId: Option.none(),
      linkedFails: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(
        flags({ diffEngine: Option.some("pg-delta"), projectRef: Option.some(FLAG_REF) }),
      );
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      // A distinct fixed ref proves the flag, not the workdir's own ref, wins.
      resolvedRef: "abcdefghijklmnopqrst",
    });
    return Effect.gen(function* () {
      yield* dbPull(
        flags({ diffEngine: Option.some("pg-delta"), projectRef: Option.some(FLAG_REF) }),
      );
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
      expect(s.cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ local: Option.some(true), projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      expect(s.resolveCalls).toEqual([]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --project-ref on the deprecated --experimental export", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, { experimental: true, edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(flags({ projectRef: Option.some(FLAG_REF) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.engineCalls[0]?.projectRef).toBe(FLAG_REF);
      expect(s.proxyCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a pg-delta plan with transaction boundaries writes one ordered migration file per unit",
    () => {
      // e.g. ALTER TYPE ... ADD VALUE followed by a statement using the new value.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "-- unit 1\n\nalter type mood add value 'ok';" },
          { name: "after_enum_values", sql: "-- unit 2\n\ninsert into t values ('ok');" },
          {
            name: "non_transactional",
            transactionMode: "none",
            sql: "-- pg-delta: transaction=false\n-- unit 3\n\ncreate index concurrently i on t (c);",
          },
        ]),
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ diffEngine: Option.some("pg-delta") }));
        const dir = join(tmp.current, "supabase", "migrations");
        const written = readdirSync(dir)
          .filter((f) => f !== "20240101000000_local.sql")
          .sort();
        expect(written).toHaveLength(3);
        expect(written[0]).toMatch(/^\d{14}_remote_schema_schema_changes\.sql$/u);
        expect(written[1]).toMatch(/^\d{14}_remote_schema_after_enum_values\.sql$/u);
        expect(written[2]).toMatch(/^\d{14}_remote_schema_non_transactional\.sql$/u);
        const versions = written.map((f) => f.slice(0, 14));
        expect((versions[0] ?? "") < (versions[1] ?? "")).toBe(true);
        expect((versions[1] ?? "") < (versions[2] ?? "")).toBe(true);
        const nonTransactional = readFileSync(join(dir, written[2] ?? ""), "utf8");
        expect(nonTransactional.startsWith("-- pg-delta: transaction=false\n")).toBe(true);
        expect(nonTransactional).toContain("create index concurrently i on t (c);");
        const err = streamText(s.out, "stderr");
        expect(err.match(/Schema written to/gu)).toHaveLength(3);
        for (const file of written) {
          expect(err).toContain(`Schema written to ${join("supabase", "migrations", file)}\n`);
        }
        expect(s.historyUpserts.length).toBe(3);
        expect(streamText(s.out, "stderr")).toContain(
          `Repaired migration history: [${versions.join(" ")}] => applied`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a multi-unit pg-delta pull reports every written migration path in the json payload",
    () => {
      // Lists every written path, not just the first (`schemaWritten`).
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        format: "json",
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "-- unit 1\n\nalter type mood add value 'ok';" },
          { name: "after_enum_values", sql: "-- unit 2\n\ninsert into t values ('ok');" },
          {
            name: "non_transactional",
            transactionMode: "none",
            sql: "-- unit 3\n\ncreate index concurrently i on t (c);",
          },
        ]),
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ diffEngine: Option.some("pg-delta") }));
        const success = s.out.messages.find((m) => m.type === "success");
        const data = success?.data as
          | { schemaWritten?: string; schemaFiles?: Array<string> }
          | undefined;
        expect(data?.schemaFiles).toHaveLength(3);
        expect(data?.schemaFiles?.[0]).toMatch(/_remote_schema_schema_changes\.sql$/u);
        expect(data?.schemaFiles?.[1]).toMatch(/_remote_schema_after_enum_values\.sql$/u);
        expect(data?.schemaFiles?.[2]).toMatch(/_remote_schema_non_transactional\.sql$/u);
        expect(data?.schemaWritten).toBe(data?.schemaFiles?.[0]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a malformed pg-delta diff envelope surfaces a parse error, not 'in sync'", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "not a valid envelope{",
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(Effect.flip);
      expect(error.message).toContain("failed to parse pg-delta diff output");
      expect(error.message).not.toContain("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  // Migra (and the legacy pg-delta opt-out) still substitute the declared-schema
  // `contrib_regression` target locally, so schema_paths still shapes their output —
  // only the next engine's pull prints this warning.
  it.effect("pulls with the next engine and warns that schema_paths no longer applies", () => {
    seedMigration(tmp.current, "20240101000000");
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["database/*.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      // The next engine's mock parses `edgeStdout` as a rendered-file envelope.
      edgeStdout: JSON.stringify({
        files: [
          {
            name: "schema_changes",
            transactionMode: "transactional",
            sql: "create table remote ();\n",
          },
        ],
      }),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(streamText(s.out, "stderr")).toContain(
        "schema_paths no longer changes the migrations baseline",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pulls with migra and does not warn about schema_paths", () => {
    seedMigration(tmp.current, "20240101000000");
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      ["[db.migrations]", 'schema_paths = ["database/*.sql"]', ""].join("\n"),
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      // Migra engine selection is proven by `edgeStdout` parsing as raw SQL below
      // (a pg-delta selection would instead try — and fail — to `JSON.parse` it).
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).not.toContain("schema_paths no longer changes the migrations baseline");
      // Connecting must print before shadow creation.
      expect(err).toContain("Connecting to remote database...\n");
      expect(err.indexOf("Connecting to remote database...")).toBeLessThan(
        err.indexOf("Creating shadow database..."),
      );
      const dir = join(tmp.current, "supabase", "migrations");
      const file = readdirSync(dir).find((f) => f.endsWith("_remote_schema.sql"));
      expect(err).toContain(`Schema written to ${join("supabase", "migrations", file ?? "")}\n`);
      expect(err).not.toContain(tmp.current);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "validates the shadow's own local config (api.tls cert file) BEFORE resolving the connection",
    () => {
      // `api.tls`'s cert/key files are only validated by `buildLocalDbContainerInputs`,
      // which must run strictly before `resolver.resolve()` — `resolveCalls` staying
      // empty here proves validation ran first, not just that the command failed.
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
      const s = setup(tmp.current, { remoteVersions: [], edgeStdout: "" });
      return Effect.gen(function* () {
        const error = yield* dbPull(flags()).pipe(Effect.flip);
        expect(error.message).toContain("failed to read TLS cert");
        expect(s.resolveCalls).toHaveLength(0);
        expect(s.connectedDatabases).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative exports declarative files (no migration)", () => {
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true), strictCoverage: true }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.engineCalls[0]?.strictCoverage).toBe(true);
      expect(s.edgeRunCount).toBe(0);
      const err = streamText(s.out, "stderr");
      expect(err).toContain("Connecting to remote database...\n");
      expect(err.indexOf("Connecting to remote database...")).toBeLessThan(
        err.indexOf("Preparing declarative schema export"),
      );
      // Prints the relative default, not the resolved absolute directory
      // (established output contract).
      expect(err).toContain(`Declarative schema written to ${join("supabase", "schemas")}\n`);
      expect(err).not.toContain(tmp.current);
      expect(existsSync(join(tmp.current, "supabase", "schemas", "public", "t.sql"))).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(tmp.current, "supabase", "schemas", ".pgdelta-export.json"), "utf8"),
        ),
      ).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["public/t.sql"],
      });
      // Declarative export reads only the live target; no shadow is provisioned.
      expect(s.connectTargets).toEqual([{ database: "postgres", port: 5432 }]);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(0);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "rm")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declarative export does not provision a baseline shadow", () => {
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "pull --declarative writes [db.migrations] schema_paths when pg-delta is disabled",
    () => {
      // Points schema_paths at the declarative dir so later db reset/db diff read the
      // pulled files (pg-delta stays disabled).
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\n");
      const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(true) }));
        const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
        expect(config).toContain("[db.migrations]");
        expect(config).toContain('schema_paths = [\n  "schemas",\n]');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative leaves schema_paths untouched when pg-delta is enabled", () => {
    // An enabled config already treats the declarative dir as source of truth, so the
    // rewrite is skipped.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    const original = "[experimental.pgdelta]\nenabled = true\n";
    writeFileSync(join(tmp.current, "supabase", "config.toml"), original);
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true) }));
      const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
      expect(config).toBe(original);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pull --declarative replaces an existing schema_paths block in place", () => {
    // A regex replace-or-append rewrites a present schema_paths block rather than
    // appending a duplicate.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      '[db.migrations]\nschema_paths = [\n  "schemas/*.sql",\n]\n',
    );
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true) }));
      const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
      expect(config).toContain('schema_paths = [\n  "schemas",\n]');
      expect(config).not.toContain("schemas/*.sql");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "deprecated --use-pg-delta prints the deprecation line and behaves like --declarative",
    () => {
      const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* dbPull(flags({ usePgDelta: Option.some(true) }));
        expect(streamText(s.out, "stderr")).toContain("Flag --use-pg-delta has been deprecated");
        expect(streamText(s.out, "stderr")).toContain(
          `Declarative schema written to ${join("supabase", "schemas")}\n`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("passes the config/workdir-resolved project id to the pg-delta engine", () => {
    // Absent env/config project_id, the workdir basename must reach the pg-delta
    // engine's project id, including on the declarative-export path (read before any
    // local shadow diff starts) — not an empty string from `CommandSettings.projectId`
    // alone.
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON, projectId: Option.none() });
    const expectedProjectId = basename(tmp.current);
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.projectId).toBe(expectedProjectId);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a linked [remotes.<ref>]'s project_id outranks a conflicting SUPABASE_PROJECT_ID",
    () => {
      // `readDbToml` gates `toml.projectId` behind `remoteOverrideKeys` for the matched
      // remote, but `resolveLocalProjectId` tries the raw ambient env first — an ambient
      // `SUPABASE_PROJECT_ID` for an unrelated project must not win back over it.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[remotes.staging]", 'project_id = "abcdefghijklmnopqrst"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        edgeStdout: EXPORT_JSON,
        resolvedRef: "abcdefghijklmnopqrst",
        projectId: Option.some("unrelated-env-project"),
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(true), linked: Option.some(true) }));
        expect(s.engineCalls[0]?.projectId).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--declarative --use-pg-delta=false stays in migration mode (Go last-occurrence-wins)",
    () => {
      // Both flags bind to one variable, so the last occurrence wins — ORing the two
      // parsed flags would wrongly take the declarative path instead.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--declarative", "--use-pg-delta=false"],
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(true), usePgDelta: Option.some(false) }));
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pg-delta --declarative=false stays in migration mode (Go last-occurrence-wins)",
    () => {
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--use-pg-delta", "--declarative=false"],
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(false), usePgDelta: Option.some(true) }));
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--declarative --use-pg-delta (both true) takes the declarative export path", () => {
    const s = setup(tmp.current, {
      edgeStdout: EXPORT_JSON,
      args: ["db", "pull", "--declarative", "--use-pg-delta"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true), usePgDelta: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(existsSync(join(tmp.current, "supabase", "schemas", "public", "t.sql"))).toBe(true);
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a migration-history conflict fails with the repair suggestion", () => {
    seedMigration(tmp.current, "20240102000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"] });
    return Effect.gen(function* () {
      const exit = yield* dbPull(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial pull (no local migrations, migra) dumps the schema natively then appends the diff",
    () => {
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "create table diffed ();\n", // the migra second pass
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.proxyCalls).toHaveLength(0);
        expect(s.proxyCaptureCalls).toHaveLength(0);
        // pg_dump ran with the schema-dump env (internal-schema exclude + comment strip).
        expect(s.dumpCalls).toHaveLength(1);
        expect(s.dumpCalls[0]?.env["EXTRA_SED"]).toBe("/^--/d");
        expect(s.dumpCalls[0]?.env["EXCLUDED_SCHEMAS"]).toContain("auth");
        expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
        // The migration file holds the dump output followed by the appended diff.
        const dir = join(tmp.current, "supabase", "migrations");
        const file = readdirSync(dir).find((f) => f.endsWith("_remote_schema.sql"));
        expect(file).toBeDefined();
        const content = readFileSync(join(dir, file ?? ""), "utf8");
        expect(content).toContain("create table dumped ();");
        expect(content).toContain("create table diffed ();");
        expect(content.indexOf("dumped")).toBeLessThan(content.indexOf("diffed"));
        // stderr order: connect → dump → shadow → diff → written. The Connecting
        // line comes first.
        const err = streamText(s.out, "stderr");
        expect(err).toContain("Connecting to remote database...\n");
        expect(err).toContain("Dumping schema from remote database...");
        expect(err).toContain("Creating shadow database...");
        expect(err).toContain(`Schema written to ${join("supabase", "migrations", file ?? "")}\n`);
        expect(err.indexOf("Connecting to remote database")).toBeLessThan(
          err.indexOf("Dumping schema"),
        );
        expect(err.indexOf("Dumping schema")).toBeLessThan(err.indexOf("Creating shadow"));
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull in json mode emits a native structured envelope", () => {
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(0);
      const success = s.out.messages.find((m) => m.type === "success");
      // Machine mode never prompts, so history updates by default (true); `schemaWritten`
      // is the real native path (not null as when delegated).
      expect(success?.data).toMatchObject({
        declarative: false,
        remoteHistoryUpdated: true,
        engine: "migra",
      });
      const data = success?.data as
        | { schemaWritten?: string; schemaFiles?: Array<string> }
        | undefined;
      expect(data?.schemaWritten).toMatch(/_remote_schema\.sql$/u);
      // Single-unit case: exactly one path, matching `schemaWritten`.
      expect(data?.schemaFiles).toHaveLength(1);
      expect(data?.schemaFiles?.[0]).toBe(data?.schemaWritten);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial pull swallows an empty migra diff once the dump wrote content", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "", // empty migra diff
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(flags()).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const dir = join(tmp.current, "supabase", "migrations");
      const file = readdirSync(dir).find((f) => f.endsWith("_remote_schema.sql"));
      expect(file).toBeDefined();
      expect(readFileSync(join(dir, file ?? ""), "utf8")).toContain("create table dumped ();");
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${join("supabase", "migrations", file ?? "")}\n`,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial pull surfaces a crashed migra script instead of the dump-only migration",
    () => {
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeFailFirstWith:
          "error diffing schema: error running script:\nTypeError: Cannot read properties of undefined (reading 'constraints')\nPGDELTA_SCRIPT_ERROR\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(flags()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          : undefined;
        const message = (error as { message?: string } | undefined)?.message ?? "";
        expect(message).toContain("Cannot read properties of undefined");
        expect(message).not.toContain("No schema changes found");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull with an empty schema reports 'No schema changes found'", () => {
    // A leftover zero-byte `<timestamp>_remote_schema.sql` seed file is a phantom local
    // migration with no remote counterpart; `--with-migration-history` can't clear it
    // since fetching empty remote history never deletes local files.
    const s = setup(tmp.current, { remoteVersions: [], dumpStdout: "", edgeStdout: "" });
    return Effect.gen(function* () {
      const error = yield* dbPull(flags()).pipe(Effect.flip);
      expect(error.message).toBe("No schema changes found");
      const dir = join(tmp.current, "supabase", "migrations");
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "two consecutive initial pulls against an empty remote history both report 'No schema changes found' with no leftover seed file",
    () => {
      const s = setup(tmp.current, { remoteVersions: [], dumpStdout: "", edgeStdout: "" });
      const dir = join(tmp.current, "supabase", "migrations");
      return Effect.gen(function* () {
        const first = yield* dbPull(flags()).pipe(Effect.flip);
        expect(first.message).toBe("No schema changes found");
        expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

        // Without the cleanup, the leftover seed file would desync this second run's
        // reconciliation: an empty remote history plus a local-only version is a
        // `DbPullMigrationConflictError`, not a repeat "No schema changes found".
        const second = yield* dbPull(flags()).pipe(Effect.flip);
        expect(second).toMatchObject({
          _tag: "DbPullInSyncError",
          message: "No schema changes found",
        });
        expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an initial-pull direct write that IPv6-fails then an empty pooler retry reports 'No schema changes found'",
    () => {
      // The file is truncated before the pooler retry, and in-sync is decided from the
      // file on disk, so an empty retry + empty diff is in sync, not a schema write. The
      // sticky `seedWroteBytes` flag must reset per attempt.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpFailFirstWith: "could not translate host name: network is unreachable",
        dumpFailFirstPartialBytes: "-- partial preamble\n",
        dumpStdout: "", // pooler retry streams nothing
        edgeStdout: "", // empty migra diff
        poolerAvailable: true,
        yes: true,
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(flags()).pipe(Effect.flip);
        expect(error.message).toBe("No schema changes found");
        expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
        expect(s.historyUpserts).toHaveLength(0); // no migration-history row written
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull fails when the pg_dump container exits non-zero", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpExitCode: 1,
      dumpStderr: "connection refused",
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(flags()).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      // The diff pass never ran — the dump failure aborts before provisioning a shadow.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial-pull dump retries via the IPv4 pooler on an IPv6 failure", () => {
    // A `--linked` direct-host dump that fails over IPv6 retries once through the
    // transaction pooler.
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpFailFirstWith: "could not translate host name: network is unreachable",
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      poolerAvailable: true,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
      expect(s.poolerFallbackCalls).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      // Printed once, before the fallback, not re-printed on the pooler retry.
      expect(err.match(/Dumping schema from remote database/gu)).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial-pull IPv6 dump failure with no pooler surfaces the dump error", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpExitCode: 1,
      dumpStderr: "could not translate host name: network is unreachable",
      poolerAvailable: false,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(flags()).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      expect(s.poolerFallbackCalls).toHaveLength(1); // gate checked, no pooler resolved
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an in-sync pull (empty diff) fails with 'No schema changes found'", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"], edgeStdout: "" });
    return Effect.gen(function* () {
      // The message and non-zero exit are the contract; the generic --debug footer is
      // replaced with this explanation instead (docs/go-cli-divergences.md).
      const error = yield* dbPull(flags()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DbPullInSyncError",
        message: "No schema changes found",
        suggestion:
          "The remote database is already in sync with your local migrations — nothing to pull.",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an empty pg-delta diff without PGDELTA_DEBUG writes no debug bundle", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"], edgeStdout: "", yes: true });
    return Effect.gen(function* () {
      const error = yield* dbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(Effect.flip);
      expect(error.message).toBe("No schema changes found");
      const debugRoot = join(tmp.current, "supabase", ".temp", "pgdelta", "debug");
      expect(existsSync(debugRoot) ? readdirSync(debugRoot) : []).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("reports the next-generation debug directory for an empty pg-delta diff", () => {
    seedMigration(tmp.current, "20240101000000");
    const debugDir = join(
      tmp.current,
      "supabase",
      ".temp",
      "pgdelta",
      "v2",
      "debug",
      "20240102-030405-678-diff",
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "",
      nextDebugDirectory: debugDir,
    });
    return Effect.gen(function* () {
      const previous = process.env["PGDELTA_DEBUG"];
      process.env["PGDELTA_DEBUG"] = "1";
      try {
        const error = yield* dbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
          Effect.flip,
        );
        expect(error.message).toBe(`No schema changes found (debug bundle: ${debugDir})`);
        expect(streamText(s.out, "stderr")).toContain(`Debug information saved to`);
        expect(streamText(s.out, "stderr")).toContain(debugDir);
      } finally {
        if (previous === undefined) delete process.env["PGDELTA_DEBUG"];
        else process.env["PGDELTA_DEBUG"] = previous;
      }
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("prompts to update history and inserts on yes (tty)", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      promptConfirmResponses: [true],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declining the history prompt does not insert (tty)", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a remote-history update failure after a successful write reports the written migration path (CLI-1272)",
    () => {
      // The migration write succeeds; only the subsequent history-table write fails.
      // The resulting `DbPullWriteError` must still carry the already-written path via
      // `writtenSoFar`, not report the write as if nothing happened.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "",
        edgeStdout: "create table remote ();\n",
        yes: true,
        historyUpdateFailWith: "connection reset by peer",
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(flags()).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DbPullWriteError" });
        const dir = join(tmp.current, "supabase", "migrations");
        const file = readdirSync(dir).find((f) => f.endsWith("_remote_schema.sql"));
        expect(file).toBeDefined();
        const writtenPath = join(dir, file ?? "");
        // Confirms the failure happened after the write, not instead of it.
        expect(existsSync(writtenPath)).toBe(true);
        expect((error as { writtenSoFar?: ReadonlyArray<string> }).writtenSoFar).toEqual([
          writtenPath,
        ]);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("updates history on an empty non-interactive stdin (Go default)", () => {
    // Only falls back to the default (`true`) when the piped scan is empty/exhausted;
    // a non-interactive pull without piped input therefore updates history. (The clack
    // prompt would hang on a non-TTY; see `pull.live.test.ts` for that end-to-end proof.)
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declines the history update on a piped 'n' (non-tty)", () => {
    // Piped stdin is scanned before defaulting, so a piped `n` cancels even on a
    // non-terminal.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(0);
      expect(streamText(s.out, "stderr")).toContain(
        "Update remote migration history table? [Y/n] n",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("emits a json envelope and suppresses 'Finished' in machine mode", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
      // Diagnostics still go to stderr in machine mode; stdout stays payload-only.
      expect(streamText(s.out, "stderr")).toContain("Connecting to remote database...\n");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ declarative: false, remoteHistoryUpdated: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("auto-accepts the history update in non-tty mode without --yes", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
      // no --yes: a non-interactive prompt falls back to the default (true).
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors SUPABASE_YES for the initial-pull history update", () => {
    // `SUPABASE_YES` auto-confirms even on a TTY with no piped answer, via the native
    // path's `resolveYesWithProjectEnv`.
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      // A TTY with no scripted prompt response: only SUPABASE_YES makes this pass.
      stdinIsTty: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
      expect(streamText(s.out, "stderr")).toContain(
        "Update remote migration history table? [Y/n] y",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(s.layer),
    );
  });

  it.effect("honors SUPABASE_YES from supabase/.env for the initial-pull history update", () => {
    // The project .env is loaded before the history prompt, so `SUPABASE_YES` there
    // auto-confirms with no shell env or --yes (`resolveYesWithProjectEnv`).
    const prev = process.env["SUPABASE_YES"];
    delete process.env["SUPABASE_YES"]; // only the project .env value must apply
    seedMigration(tmp.current, "20240101000000");
    writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_YES=true\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      // Pipe `n` on a non-TTY: only honoring the .env SUPABASE_YES (which is read
      // before stdin, so it wins over the piped decline) still updates history.
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(s.layer),
    );
  });

  it.effect(
    "resolves the pg_dump image via SUPABASE_INTERNAL_IMAGE_REGISTRY from supabase/.env",
    () => {
      // Applied before resolving the registry image, so a mirror set only in
      // supabase/.env is used for the native pg_dump seed (scoped to the run via
      // `applyProjectEnv`, reverted on close).
      const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
      delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", ".env"),
        "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
      );
      const s = setup(tmp.current, {
        remoteVersions: [], // no remote history → initial-migra pg_dump path
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.dumpCalls.length).toBeGreaterThanOrEqual(1);
        // The pg_dump container image is rewritten to the configured mirror.
        expect(s.dumpCalls[0]?.image).toMatch(/^my-mirror\.example\.com\/supabase\//u);
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
    "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
    () => {
      // A `SUPABASE_NETWORK_ID` sourced only from `supabase/.env` still overrides host
      // networking.
      const prev = process.env["SUPABASE_NETWORK_ID"];
      delete process.env["SUPABASE_NETWORK_ID"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_NETWORK_ID=dotenv-net\n");
      const s = setup(tmp.current, {
        remoteVersions: [], // no remote history → initial-migra pg_dump path
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.dumpCalls.length).toBeGreaterThanOrEqual(1);
        expect(s.dumpCalls[0]?.network).toEqual({ _tag: "named", name: "dotenv-net" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_NETWORK_ID"];
            else process.env["SUPABASE_NETWORK_ID"] = prev;
          }),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  it.effect("an explicit --yes=false overrides SUPABASE_YES and honors the piped answer", () => {
    // An explicit `--yes=false` wins over the SUPABASE_YES env — a piped `n` still
    // declines the history update rather than auto-confirming.
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
      pipedAnswers: ["n"],
      args: ["db", "pull", "--yes=false"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(s.layer),
    );
  });

  it.effect(
    "a bare --password consumes the following token, so SUPABASE_YES still auto-confirms",
    () => {
      // `--password --yes=false` parses as `--password`'s value being the literal string
      // "--yes=false" — `--yes` itself was never set — so SUPABASE_YES=1 must still
      // auto-confirm rather than the scanner misreading an explicit `--yes=false`.
      const prev = process.env["SUPABASE_YES"];
      process.env["SUPABASE_YES"] = "1";
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        // A TTY with no scripted prompt response: only SUPABASE_YES makes this pass.
        stdinIsTty: true,
        args: ["db", "pull", "--password", "--yes=false"],
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.historyUpserts.length).toBe(1);
        expect(streamText(s.out, "stderr")).toContain(
          "Update remote migration history table? [Y/n] y",
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_YES"];
            else process.env["SUPABASE_YES"] = prev;
          }),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL prints a deprecation warning and runs the in-process declarative export",
    () => {
      const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        const prev = process.env["SUPABASE_EXPERIMENTAL"];
        process.env["SUPABASE_EXPERIMENTAL"] = "true";
        try {
          yield* dbPull(flags());
        } finally {
          if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
          else process.env["SUPABASE_EXPERIMENTAL"] = prev;
        }
        expect(s.proxyCalls).toHaveLength(0);
        expect(s.engineCalls[0]?.operation).toBe("export");
        expect(streamText(s.out, "stderr")).toContain("Connecting to remote database...");
        expect(streamText(s.out, "stderr")).toContain(
          "The --experimental structured-dump mode for `db pull` is deprecated",
        );
        expect(streamText(s.out, "stderr")).toContain("Preparing declarative schema export");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "forceMigrationMode overrides SUPABASE_EXPERIMENTAL to keep runDbPull in migration mode; unset preserves the existing declarative-export resolution",
    () => {
      seedMigration(tmp.current, "20240101000000");
      const forced = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "create table remote ();" },
        ]),
      });
      const unforced = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        const prev = process.env["SUPABASE_EXPERIMENTAL"];
        process.env["SUPABASE_EXPERIMENTAL"] = "true";
        try {
          // `forceMigrationMode: true` keeps an in-process caller in migration mode
          // even though the ambient `SUPABASE_EXPERIMENTAL` gate would otherwise select
          // the deprecated declarative export.
          yield* runDbPull(flags({ diffEngine: Option.some("pg-delta") }), {
            forceMigrationMode: true,
          }).pipe(Effect.provide(forced.layer));
          expect(forced.engineCalls[0]?.operation).toBe("diff");
          expect(streamText(forced.out, "stderr")).not.toContain(
            "Preparing declarative schema export",
          );

          // Unset preserves the original behavior: the ambient gate still switches to
          // the in-process declarative export.
          yield* runDbPull(flags()).pipe(Effect.provide(unforced.layer));
          expect(unforced.engineCalls[0]?.operation).toBe("export");
          expect(streamText(unforced.out, "stderr")).toContain(
            "Preparing declarative schema export",
          );
        } finally {
          if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
          else process.env["SUPABASE_EXPERIMENTAL"] = prev;
        }
      });
    },
  );

  it.effect("--experimental still exports when the last --declarative alias is false", () => {
    const s = setup(tmp.current, {
      experimental: true,
      edgeStdout: EXPORT_JSON,
      args: ["db", "pull", "--experimental", "--declarative", "--use-pg-delta=false"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ declarative: Option.some(true), usePgDelta: Option.some(false) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.proxyCalls).toHaveLength(0);
      expect(streamText(s.out, "stderr")).toContain(
        "The --experimental structured-dump mode for `db pull` is deprecated",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--experimental with --diff-engine still runs the in-process export", () => {
    const s = setup(tmp.current, { experimental: true, edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.proxyCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "the global --experimental flag prints a deprecation warning and runs the in-process export",
    () => {
      const s = setup(tmp.current, { experimental: true, edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.proxyCalls).toHaveLength(0);
        expect(s.engineCalls[0]?.operation).toBe("export");
        expect(streamText(s.out, "stderr")).toContain("Connecting to remote database...");
        expect(streamText(s.out, "stderr")).toContain(
          "The --experimental structured-dump mode for `db pull` is deprecated",
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an experimental pull in json mode reports a declarative export with no history repair",
    () => {
      const s = setup(tmp.current, {
        experimental: true,
        format: "json",
        edgeStdout: EXPORT_JSON,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.proxyCaptureCalls).toHaveLength(0);
        const success = s.out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          declarative: true,
          remoteHistoryUpdated: false,
          engine: "pg-delta",
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--declarative wins over --experimental and is unaffected by the deprecated experimental mode",
    () => {
      // Declarative mode is checked before the experimental gate, so it runs normally
      // even when --experimental is also set.
      const s = setup(tmp.current, { experimental: true, edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(true) }));
        expect(streamText(s.out, "stderr")).toContain(
          "Preparing declarative schema export using pg-delta...",
        );
        expect(s.proxyCalls).toHaveLength(0);
        expect(streamText(s.out, "stderr")).not.toContain("is deprecated");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an explicit --experimental=false wins over SUPABASE_EXPERIMENTAL=true and pulls normally",
    () => {
      // A set flag value wins over env regardless of true/false, so `--experimental=false`
      // isn't overridden by a truthy `SUPABASE_EXPERIMENTAL`.
      const prev = process.env["SUPABASE_EXPERIMENTAL"];
      process.env["SUPABASE_EXPERIMENTAL"] = "true";
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--experimental=false"],
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(streamText(s.out, "stderr")).toContain("Connecting to remote database...\n");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = prev;
          }),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  it.effect(
    "a migration name literally '--experimental=false' after -- does not suppress SUPABASE_EXPERIMENTAL",
    () => {
      // Both pflag/cobra and this CLI's own lexer stop parsing flags at the first bare
      // `--`, so `db pull -- --experimental=false` passes it as the positional
      // migration-name argument, not a flag occurrence — unlike the unterminated case
      // above, this must still take the experimental export.
      const prev = process.env["SUPABASE_EXPERIMENTAL"];
      process.env["SUPABASE_EXPERIMENTAL"] = "true";
      const s = setup(tmp.current, {
        args: ["db", "pull", "--", "--experimental=false"],
        edgeStdout: EXPORT_JSON,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ name: Option.some("--experimental=false") }));
        expect(s.engineCalls[0]?.operation).toBe("export");
        expect(s.proxyCalls).toHaveLength(0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = prev;
          }),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  it.effect(
    "a repeated --experimental=false --experimental=true still exports (last Set() wins)",
    () => {
      // pflag/viper bind one variable per flag: repeated occurrences collapse to
      // whichever Set() call happened last, so a resolver must not get this ordering
      // backwards.
      const s = setup(tmp.current, {
        args: ["db", "pull", "--experimental=false", "--experimental=true"],
        edgeStdout: EXPORT_JSON,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.engineCalls[0]?.operation).toBe("export");
        expect(s.proxyCalls).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a bare --password consumes the following token, so SUPABASE_EXPERIMENTAL still gates the experimental export",
    () => {
      // `--password --experimental=false` parses as `--password`'s value being the
      // literal string "--experimental=false" — `--experimental` itself was never
      // Changed, so the pull must still fall back to `SUPABASE_EXPERIMENTAL=true`.
      const prev = process.env["SUPABASE_EXPERIMENTAL"];
      process.env["SUPABASE_EXPERIMENTAL"] = "true";
      const s = setup(tmp.current, {
        args: ["db", "pull", "--password", "--experimental=false"],
        edgeStdout: EXPORT_JSON,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags());
        expect(s.engineCalls[0]?.operation).toBe("export");
        expect(s.proxyCalls).toHaveLength(0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = prev;
          }),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  it.effect("a project supabase/.env enabling pg-delta selects the pg-delta engine", () => {
    // A project .env must select pg-delta even when the shell env doesn't set it.
    // The handler reads it via toml.envLookup, not process.env.
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL_PG_DELTA=true\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.engineCalls[0]?.operation).toBe("diff");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull --local with pg-delta-next diffs against the live local database", () => {
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "schemas", "public.sql"), "select 1;\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ local: Option.some(true), diffEngine: Option.some("pg-delta") }));
      expect(s.connectedDatabases).not.toContain("contrib_regression");
      expect(s.engineCalls[0]?.targetRef).toContain("@127.0.0.1:5432/postgres");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull --local with migra uses the declarative target override", () => {
    // A real declarative schema file makes the native `loadDeclaredSchemas` branch
    // non-empty, so `prepareShadowSource` redirects the diff target to the shadow's
    // own `contrib_regression` override database.
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "schemas", "public.sql"), "select 1;\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ local: Option.some(true) }));
      expect(s.connectedDatabases).toContain("contrib_regression");
      // A local target prints the local wording (established output contract).
      expect(streamText(s.out, "stderr")).toContain("Connecting to local database...\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull --local keeps migration repair suggestions local", () => {
    seedMigration(tmp.current, "20240102000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"] });
    return Effect.gen(function* () {
      const exit = yield* dbPull(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(JSON.stringify(exit)).toContain("migration repair --local --status reverted");
      expect(JSON.stringify(exit)).toContain("migration repair --local --status applied");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a migration name with a path separator fails instead of an empty-version repair",
    () => {
      // The repair globs `<timestamp>_*.sql`, which fails when the name has a path
      // separator, so the native path must not silently upsert an empty-version row.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(flags({ name: Option.some("foo/bar") })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a migration name whose nested basename is itself a valid migration filename still fails",
    () => {
      // The basename (`20250101000000_backfill.sql`) matches the migration regex, but the
      // repair glob `<generated>_*.sql` never crosses the `/`, so it misses — anchoring
      // on the generated timestamp must reject this rather than upserting the nested one.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(
          flags({ name: Option.some("dir/20250101000000_backfill") }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("machine output in a TTY without --yes skips the prompt and emits the payload", () => {
    // json/stream-json layers fail every prompt as non-interactive, so the
    // history-update prompt must be skipped (default = yes) instead of failing before
    // the payload emits.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      // no --yes
    });
    return Effect.gen(function* () {
      yield* dbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ remoteHistoryUpdated: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // The linked path merges the matching [remotes.<ref>] block before
    // experimental.pgdelta.enabled is read. Base config disables pg-delta; the
    // remote override enables it, so the migration-style pull must pick the
    // pg-delta engine.
    seedMigration(tmp.current, "20240101000000");
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
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      resolvedRef: "abcdefghijklmnopqrst",
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ linked: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(streamText(s.out, "stderr")).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // `db.migrations.enabled = "notabool"` fails config-load after the ref is
      // already cached.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[db.migrations]", 'enabled = "notabool"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        yes: true,
        resolvedRef: "abcdefghijklmnopqrst",
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(flags({ linked: Option.some(true) })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a linked [remotes.<ref>] db.major_version override reaches the shadow's OWN container spec, not just toml",
    () => {
      // The remote's own container spec must reflect the `[remotes.<ref>]` override too,
      // not just the config read for pg-delta/schema_paths; `major_version` is used as a
      // probe since PG <= 14 is the only branch that emits `--tmpfs` on `docker create`.
      seedMigration(tmp.current, "20240101000000");
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
        remoteVersions: ["20240101000000"],
        edgeStdout: "alter table x;\n",
        yes: true,
        resolvedRef: "abcdefghijklmnopqrst",
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ linked: Option.some(true) }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("retries the migration-style diff through the IPv4 pooler on an IPv6 error", () => {
    // Retries the whole shadow-provisioning + diff operation, not just the diff engine —
    // the pooler retry re-provisions and tears down a fresh shadow and re-prints both
    // banners, rather than reusing the first attempt's shadow.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nfailed to connect: network is unreachable",
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }));
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(2);
      expect(err).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(2);
      expect(
        s.shadowSpawned.filter((c) => c.args[0] === "rm" && c.args.includes("-f")),
      ).toHaveLength(2);
      expect(err.split("Creating shadow database...")).toHaveLength(3);
      expect(err.split("Diffing schemas...")).toHaveLength(3);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("retries the declarative export through the IPv4 pooler on an IPv6 error", () => {
    // The export reads only the live target, so no shadow is ever provisioned on this path.
    const s = setup(tmp.current, {
      edgeFailFirstWith: "error exporting declarative schema:\nnetwork is unreachable",
      edgeStdout: EXPORT_JSON,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ linked: Option.some(true), declarative: Option.some(true) }));
      expect(streamText(s.out, "stderr")).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "export")).toHaveLength(2);
      expect(streamText(s.out, "stderr")).toContain(
        `Declarative schema written to ${join("supabase", "schemas")}\n`,
      );
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an IPv6 diff error with no pooler available surfaces the original error", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nnetwork is unreachable",
      yes: true,
      poolerAvailable: false,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a non-IPv6 diff error is not retried through the pooler", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: 'error diffing schema:\nsyntax error at or near "foo"',
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(s.poolerFallbackCalls).toHaveLength(0);
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on --declarative with --diff-engine (mutual exclusion)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ declarative: Option.some(true), diffEngine: Option.some("migra") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  describe("shadow baseline cache", () => {
    /** The `.tar` files published under the per-test `SUPABASE_HOME` this block pins. */
    const publishedTars = () => {
      const dir = join(tmp.current, "_supabase_home", "cache", "shadow-baseline");
      return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".tar")) : [];
    };

    /**
     * Runs `db pull` with the shadow baseline cache on and artifacts under the temp root,
     * against the stateful Docker model the export/restore round trip needs.
     *
     * Each run gets its own workdir so the migration file the previous pull wrote cannot
     * shift the second run's behavior — the cache key is global and workdir-independent,
     * so two worktrees with identical settings still collide on the same tar.
     */
    const runCached = (engine: "migra" | "pg-delta") => {
      const workdir = join(tmp.current, `${engine}-worktree`);
      seedMigration(workdir, "20240101000000");
      writeFileSync(
        join(workdir, "supabase", "config.toml"),
        "[experimental.pgdelta]\nenabled = true\n",
      );
      const s = setup(workdir, {
        statefulDocker: true,
        remoteVersions: ["20240101000000"],
        edgeStdout:
          engine === "pg-delta"
            ? pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table t ();" }])
            : "create table t ();\n",
        yes: true,
      });
      return withEnvVar(
        "SUPABASE_HOME",
        join(tmp.current, "_supabase_home"),
        withEnvVar(
          "SUPABASE_SHADOW_CACHE",
          "1",
          dbPull(flags(engine === "migra" ? { diffEngine: Option.some("migra") } : {})).pipe(
            Effect.provide(s.layer),
          ),
        ),
      ).pipe(Effect.as(s));
    };

    // A migra baseline and a pg-delta baseline must not key to the same cache tar and
    // silently restore each other's cluster; `shadow-cache.integration.test.ts` covers
    // the cache's own half, this covers the call site.
    it.live("a migra-engine baseline is never restored into a pg-delta run", () => {
      return Effect.gen(function* () {
        // Migra's migrate path forces `pg_net` on regardless of config, and publishes
        // that baseline.
        const migraRun = yield* runCached("migra");
        expect(migraRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        const migraTars = publishedTars();
        expect(migraTars).toHaveLength(1);

        // pg-delta follows the config (webhooks are off here), so it must cold-provision
        // and publish its own baseline rather than restore the forced-on one above.
        const pgDeltaRun = yield* runCached("pg-delta");
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-in")).toHaveLength(0);
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        expect(publishedTars()).toHaveLength(2);
        expect(publishedTars()).toEqual(expect.arrayContaining(migraTars));
      });
    });
  });
});

describe("db remote commit", () => {
  it.effect("writes a remote_commit migration in-process and skips the pull PostRun line", () => {
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      "[experimental.pgdelta]\nenabled = true\n",
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([
        {
          name: "schema_changes",
          sql: "-- Migration unit 1: schema_changes\n\ncreate table remote ();",
        },
      ]),
      yes: true,
      args: ["db", "remote", "commit"],
    });
    return Effect.gen(function* () {
      yield* dbRemoteCommit(commitFlags());
      const dir = join(tmp.current, "supabase", "migrations");
      const written = readdirSync(dir).filter((f) => f.endsWith("_remote_commit.sql"));
      expect(written).toHaveLength(1);
      expect(readFileSync(join(dir, written[0] ?? ""), "utf8")).toContain(
        "create table remote ();",
      );
      expect(streamText(s.out, "stderr")).toContain(
        `Command "commit" is deprecated, use "db pull" instead.\n`,
      );
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${join("supabase", "migrations", written[0] ?? "")}\n`,
      );
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
      expect(s.engineCalls).toHaveLength(1);
      expect(s.engineCalls[0]?.operation).toBe("diff");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --experimental as the same in-process export as db pull", () => {
    const s = setup(tmp.current, {
      experimental: true,
      edgeStdout: EXPORT_JSON,
      args: ["db", "remote", "commit", "--experimental"],
    });
    return Effect.gen(function* () {
      yield* dbRemoteCommit(commitFlags());
      expect(s.engineCalls[0]?.operation).toBe("export");
      const err = streamText(s.out, "stderr");
      expect(err).toContain(`Command "commit" is deprecated, use "db pull" instead.\n`);
      expect(err).toContain("The --experimental structured-dump mode for `db pull` is deprecated");
      expect(existsSync(join(tmp.current, "supabase", "schemas", "public", "t.sql"))).toBe(true);
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --linked together with --db-url", () => {
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      const exit = yield* dbRemoteCommit(
        commitFlags({ linked: true, dbUrl: Option.some("postgresql://u:p@h/db") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "if any flags in the group [db-url linked local] are set none of the others can be",
      );
      expect(streamText(s.out, "stderr")).toContain(
        `Command "commit" is deprecated, use "db pull" instead.\n`,
      );
    }).pipe(Effect.provide(s.layer));
  });
});
