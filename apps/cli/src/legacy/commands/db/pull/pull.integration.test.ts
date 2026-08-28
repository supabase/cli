import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  LEGACY_VALID_REF,
  legacyWithEnv,
  mockLegacyCliSettings,
  mockLegacyDockerDaemonCliSpawner,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyShadowContainerCliSpawner,
  mockLegacyTelemetryStateTracked,
  useLegacyShadowCacheDisabled,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  type LegacyDbSession,
  LegacyDbConnection,
} from "../../../shared/legacy-db-connection.service.ts";
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
  LegacyPgDeltaEngineError,
} from "../shared/legacy-pgdelta-engine.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import { legacyDbPull } from "./pull.handler.ts";

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

// Builds the pg-delta diff envelope printed by `templates/pgdelta.ts`: one file
// per execution-aware plan unit (`{version:1,files:[{order,name,transactionMode,sql}]}`).
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
  // Fail the first edge-runtime run with this message (the second succeeds with
  // `edgeStdout`), to exercise the pooler-fallback retry.
  readonly edgeFailFirstWith?: string;
  // resolvePoolerFallback returns Some(pooler conn) when true, None otherwise.
  readonly poolerAvailable?: boolean;
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
  readonly catalogStdout?: string; // stdout returned by pg-delta catalog-export runs
  // Initial-migra pull: the bytes the native pg_dump container streams to its sink,
  // its exit code / stderr, and (when set) an IPv6 stderr that fails the FIRST dump
  // attempt so the pooler retry runs (the second attempt then streams `dumpStdout`).
  readonly dumpStdout?: string;
  readonly dumpExitCode?: number;
  readonly dumpStderr?: string;
  readonly dumpFailFirstWith?: string;
  // Bytes the FIRST dump attempt streams to its sink before it fails with
  // `dumpFailFirstWith`, reproducing a direct attempt that emits preamble then
  // exits non-zero on an IPv6 drop.
  readonly dumpFailFirstPartialBytes?: string;
  // Raw argv seen by the handler (CliArgs). Only consulted when both
  // `--declarative` and `--use-pg-delta` are present, to replay pflag's
  // last-occurrence-wins ordering; defaults to empty.
  readonly args?: ReadonlyArray<string>;
  // When set, the Nth `writeFileString` fails, exercising cleanup-on-failure.
  // `LegacyCliSettings.projectId` (the `SUPABASE_PROJECT_ID` env-only reader). Defaults
  // to `Option.some("test")`; pass `Option.none()` to exercise the
  // config.toml/workdir-basename fallback `legacyResolveLocalProjectId` provides for
  // the pg-delta edge-runtime cache bind.
  readonly projectId?: Option.Option<string>;
  // Simulates a genuinely unlinked workdir: `loadProjectRef` fails with
  // `LegacyProjectNotLinkedError` absent an explicit `--project-ref` flag,
  // instead of silently falling back to `opts.resolvedRef ?? LEGACY_VALID_REF`.
  readonly linkedFails?: boolean;
  // Swaps the stateless shadow spawner for the stateful Docker model, whose
  // `stop`/`cp`/`start` really move bytes. Required by (and only by) the tests that
  // enable the shadow BASELINE CACHE — see `mockLegacyDockerDaemonCliSpawner`.
  readonly statefulDocker?: boolean;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  // A real docker-spawner fake backs container create/start/health-inspect/cleanup.
  const shadowSpawner = mockLegacyShadowContainerCliSpawner();
  // The shadow baseline cache's cold export and warm restore only mean anything against a
  // daemon that actually holds container state and carries `docker cp` bytes, so the cache
  // tests below opt into the stateful model instead.
  const dockerDaemon =
    opts.statefulDocker === true ? mockLegacyDockerDaemonCliSpawner() : undefined;

  const engineCalls: Array<{
    operation: "diff" | "export";
    targetRef: string;
    projectRef?: string;
    projectId: string;
    strictCoverage: boolean;
  }> = [];
  let engineDiffCount = 0;
  const pgDeltaEngine = Layer.succeed(
    LegacyPgDeltaEngine,
    LegacyPgDeltaEngine.of({
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
            new LegacyPgDeltaEngineError({
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
                  debug: {
                    sourceSnapshot: opts.catalogStdout ?? "",
                    ...(opts.nextDebugDirectory !== undefined
                      ? { directory: opts.nextDebugDirectory }
                      : {}),
                  },
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
            new LegacyPgDeltaEngineError({
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
            new LegacyPgDeltaEngineError({
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
  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeRunCount += 1;
      edgeCalls.push(runOpts);
      if (opts.edgeFailFirstWith !== undefined && edgeRunCount === 1) {
        return Effect.fail(new LegacyEdgeRuntimeScriptError({ message: opts.edgeFailFirstWith }));
      }
      // pg-delta catalog exports (debug capture) use a distinct errPrefix; serve
      // them their own stdout so an empty diff can still capture non-empty catalogs.
      if (runOpts.errPrefix.includes("catalog")) {
        return Effect.succeed({ stdout: opts.catalogStdout ?? "", stderr: "" });
      }
      return Effect.succeed({ stdout: opts.edgeStdout ?? "", stderr: "" });
    },
  });

  // The initial-migra pull seeds the migration file with a native pg_dump via
  // `runStream`; deliver the configured bytes to `onStdout`, then report the exit
  // code + stderr. `dumpFailFirstWith` fails the first attempt so the pooler retry
  // runs.
  const dumpCalls: Array<{
    env: Readonly<Record<string, string>>;
    image: string;
    network: LegacyDockerRunOpts["network"];
  }> = [];
  let dumpRunCount = 0;
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        // The native shadow's PG15+ one-shot platform-baseline jobs
        // (`legacyRunStartMigrateJob`) go through this same `runStream`, always
        // `skipImageResolve: true` (the real `pg_dump` `runStream` call never sets
        // it) — succeed unconditionally so shadow setup itself never fails; this
        // suite has no assertions over the one-shot jobs' own output, and they must
        // not be counted alongside the real `dumpCalls` this suite DOES assert on.
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
  // The resolver mock's own target connection always dials port 5432; the native
  // shadow (platform baseline, `CREATE_TEMPLATE`, migrations, and — on the
  // declarative branch — the `contrib_regression` override) always dials the
  // schema-default shadow port (54320) instead — a reliable way to tell "the
  // REAL remote/local target's own history upsert" (which `historyUpserts` is
  // meant to count) apart from the shadow's OWN internal migration replay (which
  // ALSO issues a parameterized `INSERT_MIGRATION_VERSION` query, into its own
  // separate in-shadow history table).
  const TARGET_PORT = 5432;
  const makeSession = (isShadow: boolean): LegacyDbSession => {
    const exec = (sql: string) => Effect.sync(() => void execLog.push(sql));
    const query = (sql: string, params?: ReadonlyArray<unknown>) => {
      if (/SELECT version/u.test(sql)) {
        return Effect.succeed((opts.remoteVersions ?? []).map((v) => ({ version: v })));
      }
      if (!isShadow && params !== undefined) historyUpserts.push(params);
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
  const dbConnection = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: { readonly database: string; readonly port: number }) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        connectTargets.push({ database: cfg.database, port: cfg.port });
        return cfg.port === TARGET_PORT ? targetSession : shadowSession;
      }),
  });

  const poolerFallbackCalls: unknown[] = [];
  const resolveCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
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
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        proxyCaptureCalls.push({ args, env: execOpts?.env, stdin: execOpts?.stdin });
        return opts.delegateStdout ?? "";
      }),
  });

  // The linked ref is now pre-loaded (for the config-override print, ahead of
  // `resolver.resolve()`'s own network work — review: PRRT_kwDOErm0O86XHvYl) via
  // `LegacyProjectRefResolver`, mirroring the SAME ref `resolver`'s own mock embeds in
  // its `db.<ref>.<host>` connection host above, so both stay consistent regardless of
  // whether a test sets `opts.resolvedRef` (mirrors `reset.integration.test.ts`'s
  // identical mock).
  // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, same
  // as Go's `flags.LoadProjectRef` — mirror that so a test can prove the flag
  // (not just `opts.resolvedRef`) drives the linked ref.
  const projectRefResolver = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.resolvedRef ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.resolvedRef ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.resolvedRef ?? LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed(opts.resolvedRef ?? LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.resolvedRef ?? LEGACY_VALID_REF),
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
    dbConnection,
    dockerDaemon?.layer ?? shadowSpawner.layer,
    alwaysReadyHttpClientLayer,
    resolver,
    projectRefResolver,
    proxy,
    mockLegacyCliSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(
      opts.stdinIsTty ?? false,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyPgDeltaSslProbe, {
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

const flags = (over: Partial<LegacyDbPullFlags> = {}): LegacyDbPullFlags => ({
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

const tmp = useLegacyTempWorkdir();
useLegacyShadowCacheDisabled();

describe("legacy db pull", () => {
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta"), strictCoverage: true }));
      const dir = join(tmp.current, "supabase", "migrations");
      expect(existsSync(join(dir, `${"20240101000000"}_local.sql`))).toBe(true);
      // A single-unit plan keeps the unchanged `<ts>_remote_schema.sql` filename.
      const written = readdirSync(dir).filter((f) => f.endsWith("_remote_schema.sql"));
      expect(written).toHaveLength(1);
      expect(readFileSync(join(dir, written[0] ?? ""), "utf8")).toContain(
        "create table remote ();",
      );
      // Prints the workdir-relative path, never the absolute one.
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
      // The linked ref is pre-loaded (cheap, local-only) before `resolve()` runs, so
      // the post-run linked-project cache still gets the ref, matching the pattern
      // `db reset`/`db push` use.
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pulls from the project given via --project-ref without a linked workdir", () => {
    // The fake resolver fails as "unlinked" (`LegacyProjectNotLinkedError`)
    // absent the flag — only the flag can resolve a ref here.
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
      yield* legacyDbPull(
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
      // The workdir already resolves to LEGACY_VALID_REF (e.g. via
      // .temp/project-ref) — the flag must win over it.
      resolvedRef: "abcdefghijklmnopqrst",
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(
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
      const exit = yield* legacyDbPull(
        flags({ local: Option.some(true), projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      // The guard fires before any connection resolution or cache write.
      expect(s.resolveCalls).toEqual([]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --project-ref combined with --experimental before delegating", () => {
    // The bundled Go binary's own `db pull --experimental` re-resolves the
    // workdir's own linked ref itself, and `rebuildDelegateArgs` never registered
    // `--project-ref` to forward — fail up front instead of silently dropping it.
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags({ projectRef: Option.some(FLAG_REF) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref is not supported with the --experimental structured-dump pull; use --declarative instead",
      );
      expect(s.proxyCalls).toEqual([]);
      expect(s.proxyCaptureCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a pg-delta plan with transaction boundaries writes one ordered migration file per unit",
    () => {
      // pg-delta plans that cross a transaction boundary (e.g. ALTER TYPE ... ADD
      // VALUE then a statement using the new value) come back as several units; each
      // is written to its own migration file with a strictly increasing timestamp and
      // recorded in the remote history.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") }));
        const dir = join(tmp.current, "supabase", "migrations");
        const written = readdirSync(dir)
          .filter((f) => f !== "20240101000000_local.sql")
          .sort();
        expect(written).toHaveLength(3);
        // Multi-unit plans append the unit name and carry strictly increasing versions.
        expect(written[0]).toMatch(/^\d{14}_remote_schema_schema_changes\.sql$/u);
        expect(written[1]).toMatch(/^\d{14}_remote_schema_after_enum_values\.sql$/u);
        expect(written[2]).toMatch(/^\d{14}_remote_schema_non_transactional\.sql$/u);
        const versions = written.map((f) => f.slice(0, 14));
        expect((versions[0] ?? "") < (versions[1] ?? "")).toBe(true);
        expect((versions[1] ?? "") < (versions[2] ?? "")).toBe(true);
        const nonTransactional = readFileSync(join(dir, written[2] ?? ""), "utf8");
        expect(nonTransactional.startsWith("-- pg-delta: transaction=false\n")).toBe(true);
        expect(nonTransactional).toContain("create index concurrently i on t (c);");
        // One "Schema written to" line per unit, each printing the workdir-relative
        // path, and one history upsert per unit.
        const err = streamText(s.out, "stderr");
        expect(err.match(/Schema written to/gu)).toHaveLength(3);
        for (const file of written) {
          expect(err).toContain(`Schema written to ${join("supabase", "migrations", file)}\n`);
        }
        expect(s.historyUpserts.length).toBe(3);
        // Prints all versions space-separated.
        expect(streamText(s.out, "stderr")).toContain(
          `Repaired migration history: [${versions.join(" ")}] => applied`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a multi-unit pg-delta pull reports every written migration path in the json payload",
    () => {
      // The structured payload must list ALL written migration files in write order,
      // not just the first (`schemaWritten`). A pg-delta plan writes one file per unit.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") }));
        const success = s.out.messages.find((m) => m.type === "success");
        const data = success?.data as
          | { schemaWritten?: string; schemaFiles?: Array<string> }
          | undefined;
        expect(data?.schemaFiles).toHaveLength(3);
        // Paths appear in write order, each carrying its unit name.
        expect(data?.schemaFiles?.[0]).toMatch(/_remote_schema_schema_changes\.sql$/u);
        expect(data?.schemaFiles?.[1]).toMatch(/_remote_schema_after_enum_values\.sql$/u);
        expect(data?.schemaFiles?.[2]).toMatch(/_remote_schema_non_transactional\.sql$/u);
        // `schemaWritten` stays the first written path (unchanged string contract).
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
      const error = yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
        Effect.flip,
      );
      expect(error.message).toContain("failed to parse pg-delta diff output");
      expect(error.message).not.toContain("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  // The transition warning belongs to the bundled next engine only: migra (and the
  // legacy pg-delta opt-out) still substitute the declared-schema
  // `contrib_regression` target for a local database, so schema_paths does still
  // shape their output and the warning would be factually wrong.
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
      yield* legacyDbPull(flags());
      expect(streamText(s.out, "stderr")).toContain(
        "schema_paths no longer changes the migrations baseline",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pulls with migra and does not warn about schema_paths", () => {
    seedMigration(tmp.current, "20240101000000");
    // pg-delta is the default engine now, so migra requires the explicit
    // config opt-out.
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["database/*.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = false",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      // Migra engine selection is proven by `edgeStdout` parsing as raw SQL below
      // (a pg-delta selection would instead try — and fail — to `JSON.parse` it).
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).not.toContain("schema_paths no longer changes the migrations baseline");
      // Go's `ConnectByConfig` prints the Connecting line to stderr before dialing
      // (`internal/utils/connect.go:348`), ahead of any other pull output.
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
      // `toml` (`legacyReadDbToml`'s "D" pipeline) only tracks `api.tls`'s dotted keys for
      // remote-override gating, it never reads the cert/key files — that read lives in
      // `legacyBuildLocalDbContainerInputs`'s own "L" pipeline (see that call's doc comment,
      // and `diff.handler.ts`'s identical fix), and it must run strictly before
      // `resolver.resolve()` or the connectivity check ever run — so `resolveCalls` must
      // stay empty here, proving the shadow's config validation ran first, not just that
      // the command failed.
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
        const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
        expect(error.message).toContain("failed to read TLS cert");
        expect(s.resolveCalls).toHaveLength(0);
        expect(s.connectedDatabases).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative exports declarative files (no migration)", () => {
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true), strictCoverage: true }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.engineCalls[0]?.strictCoverage).toBe(true);
      expect(s.edgeRunCount).toBe(0);
      const err = streamText(s.out, "stderr");
      // Order: the connectivity check prints Connecting, then the declarative
      // export prints Preparing.
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
      // Declarative export reads only the live target: the sole connect is the
      // top-level target connect (`resolved.conn`, port 5432, database "postgres"),
      // and no shadow database is ever provisioned.
      expect(s.connectTargets).toEqual([{ database: "postgres", port: 5432 }]);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(0);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "rm")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declarative export does not provision a baseline shadow", () => {
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "pull --declarative writes [db.migrations] schema_paths when pg-delta is disabled",
    () => {
      // Points schema_paths at the declarative dir when pg-delta is disabled in
      // config (db pull does not force-enable it), so later db reset/db diff read
      // the pulled files.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        "[db]\n\n[experimental.pgdelta]\nenabled = false\n",
      );
      const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ declarative: Option.some(true) }));
        const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
        expect(config).toContain("[db.migrations]");
        expect(config).toContain('schema_paths = [\n  "schemas",\n]');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative leaves schema_paths untouched when pg-delta is enabled", () => {
    // For an enabled config the declarative dir is already the source of truth, so
    // the schema_paths rewrite is skipped (the gate reads the config value).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    const original = "[experimental.pgdelta]\nenabled = true\n";
    writeFileSync(join(tmp.current, "supabase", "config.toml"), original);
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
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
      '[db.migrations]\nschema_paths = [\n  "schemas/*.sql",\n]\n\n[experimental.pgdelta]\nenabled = false\n',
    );
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
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
        yield* legacyDbPull(flags({ usePgDelta: Option.some(true) }));
        expect(streamText(s.out, "stderr")).toContain("Flag --use-pg-delta has been deprecated");
        expect(streamText(s.out, "stderr")).toContain(
          `Declarative schema written to ${join("supabase", "schemas")}\n`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("passes the config/workdir-resolved project id to the pg-delta engine", () => {
    // No `SUPABASE_PROJECT_ID` env and no `supabase/config.toml` `project_id` — Go's
    // `Config.ProjectId` falls back to the workdir basename (`pkg/config/config.go:563-570`)
    // and `UpdateDockerIds` names the edge-runtime volume from that already-sanitized value
    // (`internal/utils/config.go:57-76`). Before the fix, `ctx.projectId` came from
    // `LegacyCliSettings.projectId` alone (env-only) and resolved to `""`, mounting
    // `supabase_edge_runtime_:/root/.cache/deno:rw` regardless of the real project — reachable
    // here via the declarative-export path (`legacyDeclarativeExportPgDelta`), which reads
    // `ctx.projectId` before any local shadow diff even starts.
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON, projectId: Option.none() });
    const expectedProjectId = basename(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.projectId).toBe(expectedProjectId);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a linked [remotes.<ref>]'s project_id outranks a conflicting SUPABASE_PROJECT_ID",
    () => {
      // `legacyReadDbToml` already gates `toml.projectId` behind `remoteOverrideKeys` so it
      // reflects the matched remote's OWN `project_id` (review: PRRT_kwDOErm0O86XHGDL) — but
      // `legacyResolveLocalProjectId` tries `cliSettings.projectId` (raw, ungated env) FIRST, so
      // an ambient `SUPABASE_PROJECT_ID` that differs from the matched remote must be
      // suppressed here too, or it silently wins back over the already-gated `toml.projectId`
      // (mirrors `diff.integration.test.ts`'s identically-named test).
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[remotes.staging]", 'project_id = "abcdefghijklmnopqrst"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        edgeStdout: EXPORT_JSON,
        resolvedRef: "abcdefghijklmnopqrst",
        // Simulates an ambient `SUPABASE_PROJECT_ID` scoped to an unrelated (e.g. local)
        // project — must NOT win over the matched remote's own `project_id`.
        projectId: Option.some("unrelated-env-project"),
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ declarative: Option.some(true), linked: Option.some(true) }));
        expect(s.engineCalls[0]?.projectId).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--declarative --use-pg-delta=false stays in migration mode (Go last-occurrence-wins)",
    () => {
      // Both flags bind to one variable, so the last occurrence wins: this
      // invocation ends false => migration mode + history repair, NOT declarative
      // export. OR-ing the two parsed flags would wrongly take the declarative path.
      seedMigration(tmp.current, "20240101000000");
      // The raw-SQL `edgeStdout` below is migra output; opt out of the pg-delta
      // default via config (the diff-engine flag is mutually exclusive with the
      // declarative alias this test exercises).
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        "[experimental.pgdelta]\nenabled = false\n",
      );
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--declarative", "--use-pg-delta=false"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(
          flags({ declarative: Option.some(true), usePgDelta: Option.some(false) }),
        );
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pg-delta --declarative=false stays in migration mode (Go last-occurrence-wins)",
    () => {
      seedMigration(tmp.current, "20240101000000");
      // Same config opt-out as above: raw-SQL `edgeStdout` is migra output and
      // the diff-engine flag would trip the declarative-alias mutual exclusion.
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        "[experimental.pgdelta]\nenabled = false\n",
      );
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--use-pg-delta", "--declarative=false"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(
          flags({ declarative: Option.some(false), usePgDelta: Option.some(true) }),
        );
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
      yield* legacyDbPull(flags({ declarative: Option.some(true), usePgDelta: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      // Reaching the declarative write (rather than a migration file / history
      // upsert) proves the declarative export path ran.
      expect(existsSync(join(tmp.current, "supabase", "schemas", "public", "t.sql"))).toBe(true);
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a migration-history conflict fails with the repair suggestion", () => {
    seedMigration(tmp.current, "20240102000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"] });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial pull (no local migrations, migra) dumps the schema natively then appends the diff",
    () => {
      // The initial-pull dump (pg_dump, now native) plus the migra diff appended.
      // No Go delegation.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "create table diffed ();\n", // the migra second pass
        yes: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(0);
      const success = s.out.messages.find((m) => m.type === "success");
      // Machine mode never prompts, so history is updated on the default (true);
      // `schemaWritten` is the real native migration path (not null as when delegated).
      expect(success?.data).toMatchObject({
        declarative: false,
        remoteHistoryUpdated: true,
        engine: "migra",
      });
      const data = success?.data as
        | { schemaWritten?: string; schemaFiles?: Array<string> }
        | undefined;
      expect(data?.schemaWritten).toMatch(/_remote_schema\.sql$/u);
      // The single-unit case lists exactly one written migration path, and it is the
      // same path as the singular `schemaWritten` field.
      expect(data?.schemaFiles).toHaveLength(1);
      expect(data?.schemaFiles?.[0]).toBe(data?.schemaWritten);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial pull swallows an empty migra diff once the dump wrote content", () => {
    // After the pg_dump seed, an empty second pass is success, not "in sync".
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "", // empty migra diff
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags({ diffEngine: Option.some("migra") })).pipe(
        Effect.exit,
      );
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
        const exit = yield* legacyDbPull(flags()).pipe(Effect.exit);
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
    // An empty dump + empty diff leaves the file empty → in sync.
    const s = setup(tmp.current, { remoteVersions: [], dumpStdout: "", edgeStdout: "" });
    return Effect.gen(function* () {
      const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
      expect(error.message).toBe("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial-pull direct write that IPv6-fails then an empty pooler retry reports 'No schema changes found'",
    () => {
      // Regression: the direct attempt streams preamble bytes then drops over IPv6;
      // the pooler retry succeeds empty. The file is truncated before the retry and
      // in-sync is decided from the file on disk, so an empty pooler retry + empty
      // diff is in sync — not a schema write + migration-history upsert. The sticky
      // `seedWroteBytes` flag must therefore reset per attempt.
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
        const error = yield* legacyDbPull(flags({ diffEngine: Option.some("migra") })).pipe(
          Effect.flip,
        );
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
      const error = yield* legacyDbPull(flags({ diffEngine: Option.some("migra") })).pipe(
        Effect.flip,
      );
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
      expect(s.poolerFallbackCalls).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      // The "Dumping schema…" line is printed once (before the fallback), not
      // re-printed on the pooler retry.
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
      const error = yield* legacyDbPull(flags({ diffEngine: Option.some("migra") })).pipe(
        Effect.flip,
      );
      expect(error.message).toContain("error running container: exit 1");
      expect(s.poolerFallbackCalls).toHaveLength(1); // gate checked, no pooler resolved
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an in-sync pull (empty diff) fails with 'No schema changes found'", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"], edgeStdout: "" });
    return Effect.gen(function* () {
      // Go's message and non-zero exit are the contract; the generic
      // "rerun with --debug" footer is replaced by an explanation instead
      // (docs/go-cli-divergences.md).
      const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LegacyDbPullInSyncError",
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
      const error = yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
        Effect.flip,
      );
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
        const error = yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("updates history on an empty non-interactive stdin (Go default)", () => {
    // Scans stdin and only falls back to the default (`true`) when the scan is
    // empty/exhausted. With no piped input a non-interactive `db pull` therefore
    // proceeds to update the remote history. (The production clack prompt would
    // hang on a non-TTY — that no-hang behavior is proven end-to-end in
    // `pull.live.test.ts`; here the empty piped scan defaults.)
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declines the history update on a piped 'n' (non-tty)", () => {
    // Regression: piped stdin is scanned before defaulting, so a piped `n` cancels
    // the history update even on a non-terminal — `schema_migrations` must not be
    // touched against the user's explicit decline.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.historyUpserts.length).toBe(0);
      // Prints the label then echoes the consumed answer.
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
      // Diagnostics still go to stderr in machine mode (the Connecting line is
      // written regardless of output format); stdout stays payload-only.
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors SUPABASE_YES for the initial-pull history update", () => {
    // `SUPABASE_YES` auto-confirms even on a TTY with no piped answer. The native
    // path resolves `yes` via `legacyResolveYesWithProjectEnv`, not the raw `--yes`
    // flag, so the shell env var is honored here too.
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
    // The project `.env` is loaded before the history prompt, so `SUPABASE_YES` set
    // only in `supabase/.env` auto-confirms — with no shell env or `--yes`. The
    // native path resolves via `legacyResolveYesWithProjectEnv`, reading the loaded
    // project env map.
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      // The project `.env` is applied before resolving the registry image, so a
      // registry mirror set only in `supabase/.env` is used for the native pg_dump
      // seed. The handler applies it with `legacyApplyProjectEnv` (scoped to the run,
      // reverted on close); the loader itself stays pure.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      // Host networking is the default, but a resolved `--network-id`/`SUPABASE_NETWORK_ID`
      // value overrides it whenever non-empty — a value sourced only from `supabase/.env`
      // still wins over host.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
    // An explicit `--yes=false` wins over the SUPABASE_YES env. `printf 'n\n' |
    // SUPABASE_YES=1 supabase --yes=false db pull` must let the piped `n` decline
    // the history update rather than auto-confirming — schema_migrations stays
    // untouched.
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      // Same value-token-consuming hazard as the --experimental scanner fix above:
      // `--password --yes=false` parses as `--password`'s VALUE being the literal
      // string "--yes=false" — `--yes` was never actually set — so SUPABASE_YES=1
      // must still auto-confirm the history update rather than a scanner wrongly
      // reading an explicit `--yes=false` here.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
    "SUPABASE_EXPERIMENTAL prints a deprecation warning and delegates the structured-dump pull to Go",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const prev = process.env["SUPABASE_EXPERIMENTAL"];
        process.env["SUPABASE_EXPERIMENTAL"] = "true";
        try {
          yield* legacyDbPull(flags());
        } finally {
          if (prev === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
          else process.env["SUPABASE_EXPERIMENTAL"] = prev;
        }
        expect(s.proxyCalls).toHaveLength(1);
        expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
        // The Go child's own `ConnectByConfig` prints the Connecting line; the
        // parent must not print it too (it would appear twice in the stream).
        expect(streamText(s.out, "stderr")).not.toContain("Connecting to");
        expect(streamText(s.out, "stderr")).toContain(
          "The --experimental structured-dump mode for `db pull` is deprecated",
        );
        // The env-sourced SUPABASE_EXPERIMENTAL never reaches the delegated child as
        // a real flag on its own — the parent must state --experimental explicitly
        // in the rebuilt argv (root's own globalArgs forwarding derives --experimental
        // from a DIFFERENT, first-occurrence-wins parse, which can disagree here).
        expect(s.proxyCalls[0]?.args).toContain("--experimental");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("forwards an explicit --local=false target flag to the delegated pull", () => {
    // Target flags are selectors keyed on flag.Changed in Go; dropping Some(false)
    // would make the delegated child default to linked instead of the local target
    // the native path selected.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ local: Option.some(false) }));
      expect(s.proxyCalls[0]?.args).toContain("--local=false");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "delegated pull forwards resolved migration mode when the last alias occurrence is false",
    () => {
      // Parent resolves migration mode (last wins = false). The rebuilt delegate
      // argv must forward that decision as `--declarative=false`, not replay the
      // truthy `--declarative` alone — Go binds both aliases to one variable, so a
      // lone `--declarative` would flip the child back to declarative export. The
      // deprecated `--use-pg-delta` must NOT be forwarded (the parent already
      // printed its deprecation line).
      const s = setup(tmp.current, {
        experimental: true,
        args: ["db", "pull", "--experimental", "--declarative", "--use-pg-delta=false"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(
          flags({ declarative: Option.some(true), usePgDelta: Option.some(false) }),
        );
        expect(s.proxyCalls[0]?.args).toContain("--declarative=false");
        expect(s.proxyCalls[0]?.args).not.toContain("--declarative");
        expect(s.proxyCalls[0]?.args).not.toContain("--use-pg-delta");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("delegated pull with --diff-engine and no alias omits --declarative entirely", () => {
    // The "alias present" guard matters: forwarding --declarative=false alongside
    // --diff-engine would trip Go's mutually-exclusive [declarative diff-engine]
    // group (which fires on Changed regardless of value). With no alias passed, the
    // delegate argv must carry only --diff-engine.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.proxyCalls[0]?.args).toContain("--diff-engine");
      expect(s.proxyCalls[0]?.args).not.toContain("--declarative=false");
      expect(s.proxyCalls[0]?.args).not.toContain("--declarative");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "the global --experimental flag prints a deprecation warning and delegates the structured-dump pull to Go",
    () => {
      // viper resolves EXPERIMENTAL from the pflag OR the env var; the flag form
      // (`supabase --experimental db pull`) must delegate just like the env form.
      const s = setup(tmp.current, { experimental: true });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags());
        expect(s.proxyCalls).toHaveLength(1);
        expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
        // The Go child's own `ConnectByConfig` prints the Connecting line; the
        // parent must not print it too (it would appear twice in the stream).
        expect(streamText(s.out, "stderr")).not.toContain("Connecting to");
        expect(streamText(s.out, "stderr")).toContain(
          "The --experimental structured-dump mode for `db pull` is deprecated",
        );
        expect(s.proxyCalls[0]?.args).toContain("--experimental");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an experimental pull in json mode reports no remote-history repair", () => {
    // The structured-dump path returns before writing a migration or touching
    // schema_migrations, so the envelope must not claim a repair.
    const s = setup(tmp.current, { experimental: true, format: "json" });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ remoteHistoryUpdated: false });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("re-quotes a comma-containing schema when delegating the pull", () => {
    // flags.schema holds the single parsed value `tenant,one`; forwarding it raw
    // would let the Go child's pflag StringSlice CSV-split it into two schemas, so
    // it must be re-encoded as a quoted CSV field.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ schema: ["tenant,one"] }));
      const args = s.proxyCalls[0]?.args ?? [];
      const idx = args.indexOf("--schema");
      expect(args[idx + 1]).toBe('"tenant,one"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--declarative wins over --experimental and is unaffected by the deprecated experimental mode",
    () => {
      // Declarative mode is checked before EXPERIMENTAL: declarative export must
      // still run normally even when --experimental is also set.
      const s = setup(tmp.current, { experimental: true, edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ declarative: Option.some(true) }));
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
      // A SET flag value wins over env regardless of whether it's true or false, so
      // `--experimental=false` must NOT be overridden by a truthy
      // `SUPABASE_EXPERIMENTAL` — the pull proceeds as normal instead of hitting the
      // retirement error.
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
        yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      // Both pflag/cobra and this CLI's own lexer (effect/unstable/cli/internal/lexer.ts,
      // `argv.indexOf("--")`) stop parsing
      // flags at the first bare `--` — `db pull -- --experimental=false` passes
      // "--experimental=false" as the positional migration-name argument, NOT as an
      // explicit flag occurrence. Unlike the unterminated `--experimental=false`
      // case above, this must still delegate to Go. `flags().name` is set to match
      // what the real parser would have produced for this argv (the positional
      // operand), so the scenario this test exists to protect is actually exercised
      // — note this does NOT assert anything about how that name is itself
      // forwarded to the delegated child (`rebuildDelegateArgs` pushes it as a bare
      // positional with no `--` terminator of its own, a separate, pre-existing,
      // unfixed gap: a name that looks like a flag could be re-parsed as one by the
      // Go child).
      const prev = process.env["SUPABASE_EXPERIMENTAL"];
      process.env["SUPABASE_EXPERIMENTAL"] = "true";
      const s = setup(tmp.current, {
        args: ["db", "pull", "--", "--experimental=false"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ name: Option.some("--experimental=false") }));
        expect(s.proxyCalls).toHaveLength(1);
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
    "a repeated --experimental=false --experimental=true still delegates (last Set() wins)",
    () => {
      // pflag/viper bind ONE variable per flag: repeated occurrences collapse to
      // whichever Set() call happened LAST. A resolver that only checks "does any
      // pre-terminator token say false" gets this ordering backwards and would
      // incorrectly skip delegating to Go.
      const s = setup(tmp.current, {
        args: ["db", "pull", "--experimental=false", "--experimental=true"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags());
        expect(s.proxyCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a bare --password consumes the following token, so SUPABASE_EXPERIMENTAL still gates the delegated structured-dump pull",
    () => {
      // pflag accepts `--flag value` (space form) for `--password` (a string flag,
      // `pull.command.ts`'s `password: Flag.string(...)`), so `--password
      // --experimental=false` parses as `--password`'s VALUE being the literal string
      // "--experimental=false" — `--experimental` was never actually Changed. A scanner
      // that examines every pre-terminator token without skipping consumed values would
      // wrongly read an explicit `--experimental=false` here and let the pull proceed
      // normally instead of falling back to SUPABASE_EXPERIMENTAL=true.
      const prev = process.env["SUPABASE_EXPERIMENTAL"];
      process.env["SUPABASE_EXPERIMENTAL"] = "true";
      const s = setup(tmp.current, {
        args: ["db", "pull", "--password", "--experimental=false"],
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags());
        expect(s.proxyCalls).toHaveLength(1);
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
      yield* legacyDbPull(flags());
      expect(s.engineCalls[0]?.operation).toBe("diff");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "defaults to the pg-delta engine when config has no [experimental.pgdelta] section",
    () => {
      // CLI-1588: pg-delta is the default schema diff engine. With no config
      // section and no --diff-engine flag, the migration-style pull must call
      // the pg-delta engine's diffDatabase, never migra's edge-runtime script.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "create table remote ();" },
        ]),
        yes: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags());
        expect(s.engineCalls).toHaveLength(1);
        expect(s.engineCalls[0]?.operation).toBe("diff");
        expect(s.edgeRunCount).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("[experimental.pgdelta] enabled = false in config selects the migra engine", () => {
    // Explicit config opt-out from the pg-delta default: the pull must run
    // migra's edge-runtime diff and never touch the pg-delta engine. Migra
    // selection is also proven by the raw-SQL `edgeStdout` being written as a
    // migration (pg-delta would fail to JSON.parse it).
    seedMigration(tmp.current, "20240101000000");
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      "[experimental.pgdelta]\nenabled = false\n",
    );
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.engineCalls).toHaveLength(0);
      expect(s.edgeRunCount).toBe(1);
      const dir = join(tmp.current, "supabase", "migrations");
      expect(readdirSync(dir).some((f) => f.endsWith("_remote_schema.sql"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--diff-engine migra forces migra even when config leaves the default on", () => {
    // No config.toml at all, so the config-level default is pg-delta; the
    // explicit flag must still win and select migra.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.engineCalls).toHaveLength(0);
      expect(s.edgeRunCount).toBe(1);
      const dir = join(tmp.current, "supabase", "migrations");
      expect(readdirSync(dir).some((f) => f.endsWith("_remote_schema.sql"))).toBe(true);
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
      yield* legacyDbPull(flags({ local: Option.some(true), diffEngine: Option.some("pg-delta") }));
      expect(s.connectedDatabases).not.toContain("contrib_regression");
      expect(s.engineCalls[0]?.targetRef).toContain("@127.0.0.1:5432/postgres");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull --local with migra uses the declarative target override", () => {
    // Go derives the shadow targetLocal from utils.IsLocalDatabase and substitutes
    // the declarative contrib_regression target override (diff.go:190,196-197); a
    // real declarative schema file makes the native `loadDeclaredSchemas` branch
    // non-empty, so `legacyPrepareShadowSource` redirects the diff target to the
    // shadow's own `contrib_regression` override database.
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "schemas", "public.sql"), "select 1;\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ local: Option.some(true), diffEngine: Option.some("migra") }));
      expect(s.connectedDatabases).toContain("contrib_regression");
      // A local target prints the local wording (established output contract).
      expect(streamText(s.out, "stderr")).toContain("Connecting to local database...\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull --local keeps migration repair suggestions local", () => {
    seedMigration(tmp.current, "20240102000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"] });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(JSON.stringify(exit)).toContain("migration repair --local --status reverted");
      expect(JSON.stringify(exit)).toContain("migration repair --local --status applied");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a migration name with a path separator fails instead of an empty-version repair",
    () => {
      // The repair globs `<timestamp>_*.sql`, which fails when the name has a path
      // separator (the file is nested), so the native path must not silently upsert
      // an empty-version migration-history row.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbPull(flags({ name: Option.some("foo/bar") })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a migration name whose nested basename is itself a valid migration filename still fails",
    () => {
      // `dir/20250101000000_backfill` writes a nested file whose basename
      // (`20250101000000_backfill.sql`) matches the migration regex, but the repair
      // glob `<generated>_*.sql` never crosses the `/`, so it misses and fails.
      // Anchoring on the generated timestamp must reject this rather than upserting
      // the user's nested timestamp as applied.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbPull(
          flags({ name: Option.some("dir/20250101000000_backfill") }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("machine output in a TTY without --yes skips the prompt and emits the payload", () => {
    // Regression: json/stream-json layers fail every prompt as non-interactive, so
    // the history-update prompt must be skipped (default = yes) instead of failing
    // the command before the structured success payload is emitted.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      // no --yes
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("migra") }));
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
      yield* legacyDbPull(flags({ linked: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("diff");
      // pg-delta selection is ref-aware (read from the remote-merged `toml.pgDelta`)
      // and is proven by `edgeStdout`'s envelope shape parsing successfully below.
      expect(streamText(s.out, "stderr")).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // The project ref is cached the moment it's known, and stays cached even when
      // a LATER step (here, `legacyReadDbToml`'s own config-load) fails afterward.
      // `db.migrations.enabled = "notabool"` fails `legacyReadDbToml`'s own bool
      // parse AFTER the ref is already known, exercising exactly that gap
      // (`diff.integration.test.ts`'s identical fix/test).
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
        const exit = yield* legacyDbPull(flags({ linked: Option.some(true) })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a linked [remotes.<ref>] db.major_version override reaches the shadow's OWN container spec, not just toml",
    () => {
      // The WHOLE config is remote-merged uniformly on the linked path — the shadow's
      // container spec (image, JWT secret, root key, db.settings, service
      // enabled-for-setup flags) must reflect the matched `[remotes.<ref>]` override
      // too, not just the `toml` read used for pg-delta/schema_paths (mirrors
      // `diff.integration.test.ts`'s identically-named test).
      // `major_version` is a clean, directly-observable probe: PG <= 14 is the ONLY branch
      // that emits a `--tmpfs` flag on the shadow's `docker create` argv
      // (`legacyBuildShadowPostgresContainerSpec`) — a base config of 17 (>= 15, no tmpfs)
      // overridden by a remote block's `major_version = 14` must flip that flag on.
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
        yield* legacyDbPull(flags({ linked: Option.some(true), diffEngine: Option.some("migra") }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("retries the migration-style diff through the IPv4 pooler on an IPv6 error", () => {
    // The linked diff retries against the IPv4 pooler when the direct host is
    // unreachable over IPv6 from the container. The first edge run fails with an
    // IPv6 connectivity error; the retry succeeds and the migration is written.
    //
    // This retries the WHOLE shadow-provisioning + diff operation on this path,
    // not just the diff engine (shadow provisioning prints "Creating shadow
    // database..."/"Diffing schemas..." before ever touching the target
    // connection) — so the pooler retry re-provisions and tears down a FRESH
    // shadow and re-prints both banners, rather than reusing the first attempt's
    // shadow. Assert that shape directly, not just that the migration eventually
    // gets written.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nfailed to connect: network is unreachable",
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(
        flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }),
      );
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
    // The declarative export retries through the pooler in the same IPv6
    // scenario. The export reads only the live target, so no shadow database is
    // ever provisioned on this path.
    const s = setup(tmp.current, {
      edgeFailFirstWith: "error exporting declarative schema:\nnetwork is unreachable",
      edgeStdout: EXPORT_JSON,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ linked: Option.some(true), declarative: Option.some(true) }));
      expect(streamText(s.out, "stderr")).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "export")).toHaveLength(2);
      expect(streamText(s.out, "stderr")).toContain(
        `Declarative schema written to ${join("supabase", "schemas")}\n`,
      );
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an IPv6 diff error with no pooler available surfaces the original error", () => {
    // A pooler resolution failure surfaces the ORIGINAL diff error rather than a
    // retry error.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nnetwork is unreachable",
      yes: true,
      poolerAvailable: false,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(
        flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a non-IPv6 diff error is not retried through the pooler", () => {
    // Only IPv6 connectivity errors are eligible; any other failure surfaces as-is
    // without consulting the pooler.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: 'error diffing schema:\nsyntax error at or near "foo"',
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(
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
      const exit = yield* legacyDbPull(
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
     * Each run gets its OWN workdir so the migration file the previous pull wrote cannot shift
     * the second run's behaviour — the cache key is global and deliberately workdir-independent,
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
      return legacyWithEnv(
        "SUPABASE_HOME",
        join(tmp.current, "_supabase_home"),
        legacyWithEnv(
          "SUPABASE_SHADOW_CACHE",
          "1",
          legacyDbPull(flags(engine === "migra" ? { diffEngine: Option.some("migra") } : {})).pipe(
            Effect.provide(s.layer),
          ),
        ),
      ).pipe(Effect.as(s));
    };

    // Regression: both migrate paths used to pass a hardcoded `{ webhooks: "enabled" }`, so the
    // migra run's forced-`pg_net` baseline and the pg-delta run's config-following baseline keyed
    // to the SAME tar and silently restored each other's cluster. The handler now forks the
    // policy on `migrationMode`; `shadow-cache.integration.test.ts` covers the cache's half of
    // the contract, this covers `db pull`'s call site.
    it.live("a migra-engine baseline is never restored into a pg-delta run", () => {
      return Effect.gen(function* () {
        // Migra's migrate path forces `pg_net` on regardless of config, and publishes
        // that baseline.
        const migraRun = yield* runCached("migra");
        expect(migraRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        const migraTars = publishedTars();
        expect(migraTars).toHaveLength(1);

        // pg-delta follows the config (webhooks are off here), so it must cold-provision
        // and publish its OWN baseline rather than restore the forced-on one above.
        const pgDeltaRun = yield* runCached("pg-delta");
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-in")).toHaveLength(0);
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        expect(publishedTars()).toHaveLength(2);
        expect(publishedTars()).toEqual(expect.arrayContaining(migraTars));
      });
    });
  });
});
