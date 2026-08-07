import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  legacyFailWriteStringOnNthCallFsLayer,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
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
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import { legacyDbPull } from "./pull.handler.ts";

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
  readonly engineImplementation?: "next" | "legacy";
  readonly nextDebugDirectory?: string;
  readonly format?: OutputFormat;
  readonly remoteVersions?: ReadonlyArray<string>;
  readonly edgeStdout?: string; // diff SQL or declarative export JSON
  readonly stdinIsTty?: boolean;
  // Piped (non-TTY) stdin answers, one consumed per confirmation prompt.
  readonly pipedAnswers?: ReadonlyArray<string>;
  readonly yes?: boolean;
  readonly experimental?: boolean;
  readonly shadowTargetOverride?: string;
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
  readonly failWriteOnCall?: number;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const provisionCalls: Array<{
    mode: string;
    usePgDelta: boolean;
    targetLocal: boolean;
    projectRef?: string;
  }> = [];
  const removedContainers: string[] = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: () => Effect.succeed("supabase/.temp/pgdelta/x.json"),
    execInherit: () => Effect.succeed(0),
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () => Effect.void,
    provisionShadow: ({ mode, usePgDelta, targetLocal, projectRef }) => {
      provisionCalls.push({ mode, usePgDelta, targetLocal, projectRef });
      return Effect.succeed({
        container: "shadow-1",
        sourceUrl: "postgres://postgres:postgres@127.0.0.1:54320/postgres",
        targetUrlOverride: opts.shadowTargetOverride,
      });
    },
    provisionNextShadow: () => Effect.die("provisionNextShadow not used"),
    removeShadowContainer: (container) =>
      Effect.sync(() => {
        removedContainers.push(container);
      }),
  });

  const engineCalls: Array<{
    operation: "diff" | "export";
    targetRef: string;
    projectRef?: string;
    targetLocal?: boolean;
  }> = [];
  let engineDiffCount = 0;
  const pgDeltaEngine = Layer.succeed(
    LegacyPgDeltaEngine,
    LegacyPgDeltaEngine.of({
      implementation: opts.engineImplementation ?? "legacy",
      diffExplicit: () => Effect.die("diffExplicit unused"),
      diffDatabase: (input) => {
        engineCalls.push({
          operation: "diff",
          targetRef: input.target.ref,
          projectRef: input.projectRef,
          targetLocal: input.targetLocal,
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
                  debug:
                    opts.engineImplementation === "next"
                      ? {
                          sourceSnapshot: opts.catalogStdout ?? "",
                          ...(opts.nextDebugDirectory !== undefined
                            ? { directory: opts.nextDebugDirectory }
                            : {}),
                        }
                      : { sourceSnapshot: opts.catalogStdout ?? "", stderr: "" },
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
            return {
              sequence: index + 1,
              name,
              sql,
              transactional: transactionMode !== "none",
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
          files: [{ name: "schemas/public/t.sql", sql: "create table t ();" }],
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
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeRunCount += 1;
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
  // `runStream`; deliver the configured bytes to `onStdout` (as Go's StdCopy would),
  // then report the exit code + stderr. `dumpFailFirstWith` fails the first attempt
  // so the pooler retry runs.
  const dumpCalls: Array<{ env: Readonly<Record<string, string>>; image: string }> = [];
  let dumpRunCount = 0;
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        dumpRunCount += 1;
        dumpCalls.push({ env: runOpts.env, image: runOpts.image });
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
  const session = {
    exec: (sql: string) => Effect.sync(() => void execLog.push(sql)),
    query: (sql: string, params?: ReadonlyArray<unknown>) => {
      if (/SELECT version/u.test(sql)) {
        return Effect.succeed((opts.remoteVersions ?? []).map((v) => ({ version: v })));
      }
      if (params !== undefined) historyUpserts.push(params);
      return Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
    },
    extensionExists: () => Effect.die("extensionExists unused"),
    copyToCsv: () => Effect.die("copyToCsv unused"),
    queryRaw: () => Effect.die("queryRaw unused"),
  };
  const dbConnection = Layer.succeed(LegacyDbConnection, {
    connect: () => Effect.succeed(session),
  });

  const poolerFallbackCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: ({ connType }) =>
      Effect.succeed({
        conn: {
          // A direct `db.<ref>.<projectHost>` host so the pooler-fallback gate
          // (Go's ProjectRefFromDirectDbHost) matches on the linked path.
          host: connType === "local" ? "127.0.0.1" : "db.abcdefghijklmnopqrst.supabase.co",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: connType === "local",
        ref: opts.resolvedRef !== undefined ? Option.some(opts.resolvedRef) : Option.none(),
      }),
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

  // The linked ref is pre-loaded (for the post-run cache) before `resolve()`,
  // mirroring Go's `LoadProjectRef`-before-`NewDbConfigWithPassword` order (see the
  // pre-load block in `pull.handler.ts`, CLI-1879). Default to the same ref the
  // `LegacyDbConfigResolver` mock above uses for its `db.<ref>.…` host so both stay
  // consistent unless a test overrides `resolvedRef`.
  const projectRefResolver = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.resolvedRef ?? "abcdefghijklmnopqrst"),
    resolveForLink: () => Effect.succeed(opts.resolvedRef ?? "abcdefghijklmnopqrst"),
    resolveOptional: () => Effect.succeed(Option.some(opts.resolvedRef ?? "abcdefghijklmnopqrst")),
    loadProjectRef: () => Effect.succeed(opts.resolvedRef ?? "abcdefghijklmnopqrst"),
    promptProjectRef: () => Effect.succeed(opts.resolvedRef ?? "abcdefghijklmnopqrst"),
  });

  const baseLayer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    pgDeltaEngine,
    edge,
    docker,
    dbConnection,
    resolver,
    proxy,
    projectRefResolver,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(
      opts.stdinIsTty ?? false,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyPgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockRuntimeInfo(),
    BunServices.layer,
  );
  // Merged last so its `FileSystem` overrides `BunServices` (last-wins); `Path`
  // still resolves from `BunServices`.
  const layer =
    opts.failWriteOnCall === undefined
      ? baseLayer
      : Layer.merge(baseLayer, legacyFailWriteStringOnNthCallFsLayer(opts.failWriteOnCall));

  return {
    layer,
    out,
    cache,
    provisionCalls,
    removedContainers,
    proxyCalls,
    proxyCaptureCalls,
    historyUpserts,
    execLog,
    poolerFallbackCalls,
    dumpCalls,
    engineCalls,
    get edgeRunCount() {
      return edgeRunCount;
    },
  };
}

const flags = (over: Partial<LegacyDbPullFlags> = {}): LegacyDbPullFlags => ({
  name: over.name ?? Option.none(),
  declarative: over.declarative ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  diffEngine: over.diffEngine ?? Option.none(),
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
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
      yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") }));
      const dir = join(tmp.current, "supabase", "migrations");
      expect(existsSync(join(dir, `${"20240101000000"}_local.sql`))).toBe(true);
      // A single-unit plan keeps the unchanged `<ts>_remote_schema.sql` filename.
      const written = readdirSync(dir).filter((f) => f.endsWith("_remote_schema.sql"));
      expect(written).toHaveLength(1);
      expect(readFileSync(join(dir, written[0] ?? ""), "utf8")).toContain(
        "create table remote ();",
      );
      // Go prints the workdir-relative path (`pull.go:76`), never the absolute one.
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${join("supabase", "migrations", written[0] ?? "")}\n`,
      );
      expect(streamText(s.out, "stderr")).not.toContain(tmp.current);
      expect(s.historyUpserts.length).toBe(1);
      expect(s.engineCalls).toHaveLength(1);
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(s.edgeRunCount).toBe(0);
      expect(streamText(s.out, "stdout")).toContain("Finished supabase db pull.");
      // The linked ref is pre-loaded (cheap, local-only) before `resolve()` runs, so
      // the post-run linked-project cache still gets the ref Go would cache via
      // `LoadProjectRef`, matching the CLI-1879 pattern `db reset`/`db push` use.
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a pg-delta plan with transaction boundaries writes one ordered migration file per unit",
    () => {
      // pg-delta plans that cross a transaction boundary (e.g. ALTER TYPE ... ADD
      // VALUE then a statement using the new value) come back as several units; each
      // is written to its own migration file with a strictly increasing timestamp and
      // recorded in the remote history. Mirrors Go's `writePgDeltaMigrations`.
      seedMigration(tmp.current, "20240101000000");
      const s = setup(tmp.current, {
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
        expect(readFileSync(join(dir, written[2] ?? ""), "utf8")).toContain(
          "create index concurrently i on t (c);",
        );
        // One "Schema written to" line per unit, each printing the workdir-relative
        // path (Go's `pull.go:76`), and one history upsert per unit.
        const err = streamText(s.out, "stderr");
        expect(err.match(/Schema written to/gu)).toHaveLength(3);
        for (const file of written) {
          expect(err).toContain(`Schema written to ${join("supabase", "migrations", file)}\n`);
        }
        expect(s.historyUpserts.length).toBe(3);
        // Go's UpdateMigrationTable prints all versions space-separated.
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

  it.effect("removes already-written unit files when a later pg-delta unit write fails", () => {
    // A mid-loop write failure best-effort removes every migration file this
    // invocation already wrote, so no partial multi-file pull is left behind.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      failWriteOnCall: 2,
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ]),
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const dir = join(tmp.current, "supabase", "migrations");
      // Only the pre-seeded local migration remains; the first written unit was
      // rolled back and the failing second unit never landed.
      expect(readdirSync(dir)).toEqual(["20240101000000_local.sql"]);
      // No history rows were upserted because the write failed before the prompt.
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

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

  it.effect("pulls with the default migra engine", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.provisionCalls[0]?.usePgDelta).toBe(false);
      const err = streamText(s.out, "stderr");
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

  it.effect("pull --declarative exports declarative files (no migration)", () => {
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.edgeRunCount).toBe(0);
      const err = streamText(s.out, "stderr");
      // Go's order: `ConnectByConfig` prints Connecting (`pull.go:40`), then
      // `pullDeclarativePgDelta` prints Preparing (`pull.go:93`).
      expect(err).toContain("Connecting to remote database...\n");
      expect(err.indexOf("Connecting to remote database...")).toBeLessThan(
        err.indexOf("Preparing declarative schema export"),
      );
      // Go prints `utils.GetDeclarativeDir()` — the relative default, not the
      // resolved absolute directory (`pull.go:119`).
      expect(err).toContain(`Declarative schema written to ${join("supabase", "database")}\n`);
      expect(err).not.toContain(tmp.current);
      expect(
        existsSync(join(tmp.current, "supabase", "database", "schemas", "public", "t.sql")),
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(tmp.current, "supabase", "database", ".pgdelta-export.json"), "utf8"),
        ),
      ).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["schemas/public/t.sql"],
      });
      expect(s.provisionCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "pull --declarative writes [db.migrations] schema_paths when pg-delta is disabled",
    () => {
      // Go's WriteDeclarativeSchemas points schema_paths at the declarative dir when
      // pg-delta is disabled in config (db pull does not force-enable it), so later
      // db reset/db diff read the pulled files (declarative.go:260-268).
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\n");
      const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags({ declarative: Option.some(true) }));
        const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
        expect(config).toContain("[db.migrations]");
        expect(config).toContain('schema_paths = [\n  "database",\n]');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative leaves schema_paths untouched when pg-delta is enabled", () => {
    // For an enabled config the declarative dir is already the source of truth, so
    // Go skips the schema_paths rewrite (the gate reads the config value).
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
    // Go's regex replace-or-append rewrites a present schema_paths block rather
    // than appending a duplicate (declarative.go:285-303).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      '[db.migrations]\nschema_paths = [\n  "schemas/*.sql",\n]\n',
    );
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
      const config = readFileSync(join(tmp.current, "supabase", "config.toml"), "utf8");
      expect(config).toContain('schema_paths = [\n  "database",\n]');
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
          `Declarative schema written to ${join("supabase", "database")}\n`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--declarative --use-pg-delta=false stays in migration mode (Go last-occurrence-wins)",
    () => {
      // Go binds both flags to one variable, so the last occurrence wins: this
      // invocation ends false => migration mode + history repair, NOT declarative
      // export. OR-ing the two parsed flags would wrongly take the declarative path.
      seedMigration(tmp.current, "20240101000000");
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
        expect(s.provisionCalls[0]?.mode).toBe("diff");
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
        yield* legacyDbPull(
          flags({ declarative: Option.some(false), usePgDelta: Option.some(true) }),
        );
        expect(s.provisionCalls[0]?.mode).toBe("diff");
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
      expect(s.provisionCalls).toHaveLength(0);
      expect(s.engineCalls[0]?.operation).toBe("export");
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
      // Go's `run` → `dumpRemoteSchema` (pg_dump, now native) + `diffRemoteSchema(nil)`
      // appended (`pull.go:117-141`). No Go delegation.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "create table diffed ();\n", // the migra second pass
        yes: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbPull(flags());
        expect(s.proxyCalls).toHaveLength(0);
        expect(s.proxyCaptureCalls).toHaveLength(0);
        // pg_dump ran with the schema-dump env (internal-schema exclude + comment strip).
        expect(s.dumpCalls).toHaveLength(1);
        expect(s.dumpCalls[0]?.env["EXTRA_SED"]).toBe("/^--/d");
        expect(s.dumpCalls[0]?.env["EXCLUDED_SCHEMAS"]).toContain("auth");
        // The diff ran against the shadow with the migra engine (no schema filter).
        expect(s.provisionCalls[0]?.usePgDelta).toBe(false);
        // The migration file holds the dump output followed by the appended diff.
        const dir = join(tmp.current, "supabase", "migrations");
        const file = readdirSync(dir).find((f) => f.endsWith("_remote_schema.sql"));
        expect(file).toBeDefined();
        const content = readFileSync(join(dir, file ?? ""), "utf8");
        expect(content).toContain("create table dumped ();");
        expect(content).toContain("create table diffed ();");
        expect(content.indexOf("dumped")).toBeLessThan(content.indexOf("diffed"));
        // stderr order: connect → dump → shadow → diff → written. The Connecting
        // line comes first (Go's `ConnectByConfig` at the top of `pull.Run`).
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
      yield* legacyDbPull(flags());
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(0);
      const success = s.out.messages.find((m) => m.type === "success");
      // Machine mode never prompts, so history is updated on Go's default (true);
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
    // Go's `swallowInitialInSync` (`pull.go:256-261`): after the pg_dump seed, an
    // empty second pass is success, not "in sync".
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "", // empty migra diff
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags()).pipe(Effect.exit);
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

  it.effect("an initial pull with an empty schema reports 'No schema changes found'", () => {
    // Go's `ensureMigrationWritten` (`pull.go:68,263-268`): an empty dump + empty diff
    // leaves the file empty → in sync.
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
      // the pooler retry succeeds empty. Go truncates the file before the retry
      // (`resetOutput`, pooler_fallback.go:98-113) and decides in-sync from the file
      // on disk (`hasMigrationContent`, pull.go:251-268), so an empty pooler retry +
      // empty diff is in sync — not a schema write + migration-history upsert. The
      // sticky `seedWroteBytes` flag must therefore reset per attempt.
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
        const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
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
      const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      // The diff pass never ran — the dump failure aborts before provisioning a shadow.
      expect(s.provisionCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial-pull dump retries via the IPv4 pooler on an IPv6 failure", () => {
    // Go's `dump.RunWithPoolerFallback`: a `--linked` direct-host dump that fails over
    // IPv6 retries once through the transaction pooler (`pull.go:155`).
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpFailFirstWith: "could not translate host name: network is unreachable",
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      poolerAvailable: true,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
      expect(s.poolerFallbackCalls).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      // The "Dumping schema…" line is printed once (before the fallback), not re-printed
      // on the pooler retry (Go's `PoolerFallbackConfig` only emits the warning).
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
      const error = yield* legacyDbPull(flags()).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      expect(s.poolerFallbackCalls).toHaveLength(1); // gate checked, no pooler resolved
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an in-sync pull (empty diff) fails with 'No schema changes found'", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"], edgeStdout: "" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an empty pg-delta diff under PGDELTA_DEBUG saves a debug bundle and reports it",
    () => {
      // Go saves a debug bundle and embeds its path in the in-sync error when
      // PGDELTA_DEBUG is set on an empty pg-delta diff (internal/db/pull/pull.go:176-185).
      seedMigration(tmp.current, "20240101000000");
      const catalog = JSON.stringify({ tables: [{ schema: "public", name: "t" }] });
      const s = setup(tmp.current, {
        remoteVersions: ["20240101000000"],
        edgeStdout: "", // empty diff
        catalogStdout: catalog, // shadow + remote catalog exports succeed
        yes: true,
      });
      return Effect.gen(function* () {
        const prev = process.env["PGDELTA_DEBUG"];
        process.env["PGDELTA_DEBUG"] = "1";
        try {
          const error = yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") })).pipe(
            Effect.flip,
          );
          expect(error.message).toContain("No schema changes found (debug bundle:");
        } finally {
          if (prev === undefined) delete process.env["PGDELTA_DEBUG"];
          else process.env["PGDELTA_DEBUG"] = prev;
        }
        const debugRoot = join(tmp.current, "supabase", ".temp", "pgdelta", "debug");
        const ids = existsSync(debugRoot) ? readdirSync(debugRoot) : [];
        expect(ids).toHaveLength(1);
        const bundleDir = join(debugRoot, ids[0] ?? "");
        const files = readdirSync(bundleDir);
        expect(files).toContain("source-catalog.json");
        expect(files).toContain("target-catalog.json");
        expect(files).toContain("connection.txt");
        expect(files).toContain("error.txt");
        expect(readFileSync(join(bundleDir, "error.txt"), "utf8")).toBe("No schema changes found");
        // connection.txt is password-redacted (Go's redactPostgresURL → xxxxx).
        expect(readFileSync(join(bundleDir, "connection.txt"), "utf8")).toContain(
          "url=postgresql://postgres:xxxxx@",
        );
        expect(streamText(s.out, "stderr")).toContain("pg-delta returned 0 statements.");
        expect(streamText(s.out, "stderr")).toContain("Debug bundle saved to");
      }).pipe(Effect.provide(s.layer));
    },
  );

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
      engineImplementation: "next",
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
      yield* legacyDbPull(flags());
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
      yield* legacyDbPull(flags());
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("updates history on an empty non-interactive stdin (Go default)", () => {
    // Go's `PromptYesNo` scans stdin and only falls back to the default (`true`) when
    // the scan is empty/exhausted (`console.go:64-82`). With no piped input a
    // non-interactive `db pull` therefore proceeds to update the remote history.
    // (The production clack prompt would hang on a non-TTY — that no-hang behavior is
    // proven end-to-end in `pull.live.test.ts`; here the empty piped scan defaults.)
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declines the history update on a piped 'n' (non-tty)", () => {
    // Regression: Go scans piped stdin before defaulting (`console.go:74-82`), so a
    // piped `n` cancels the history update even on a non-terminal — `schema_migrations`
    // must not be touched against the user's explicit decline.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.historyUpserts.length).toBe(0);
      // Go prints the label then echoes the consumed answer (`console.go:96-102`).
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
      yield* legacyDbPull(flags());
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
      // Diagnostics still go to stderr in machine mode (Go writes the Connecting
      // line to os.Stderr regardless of output format); stdout stays payload-only.
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
      // no --yes: a non-interactive prompt falls back to the default (true),
      // matching Go's PromptYesNo returning `def` on error/timeout.
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors SUPABASE_YES for the initial-pull history update", () => {
    // Go's `PromptYesNo` reads `viper.GetBool("YES")`, which includes the
    // `SUPABASE_YES` env var (AutomaticEnv), so it auto-confirms even on a TTY with
    // no piped answer. The native path resolves `yes` via `legacyResolveYesWithProjectEnv`,
    // not the raw `--yes` flag, so the shell env var is honored here too.
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
      yield* legacyDbPull(flags());
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
    // Go loads the project `.env` (loadNestedEnv) inside ParseDatabaseConfig before
    // PromptYesNo (config.go:701), so `SUPABASE_YES` set only in `supabase/.env`
    // auto-confirms — with no shell env or `--yes`. The native path resolves via
    // `legacyResolveYesWithProjectEnv`, reading the loaded project env map.
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
      yield* legacyDbPull(flags());
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
      // Go's LoadConfig applies the project `.env` (os.Setenv) before GetRegistryImageUrl,
      // so a registry mirror set only in `supabase/.env` is used for the native pg_dump
      // seed. The handler mirrors that with `legacyApplyProjectEnv` (scoped to the run,
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
        yield* legacyDbPull(flags());
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

  it.effect("an explicit --yes=false overrides SUPABASE_YES and honors the piped answer", () => {
    // Go binds `--yes` to viper, so an explicit `--yes=false` wins over the
    // SUPABASE_YES env (AutomaticEnv). `printf 'n\n' | SUPABASE_YES=1 supabase
    // --yes=false db pull` must let the piped `n` decline the history update rather
    // than auto-confirming — schema_migrations stays untouched.
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
      yield* legacyDbPull(flags());
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
      // Same value-token-consuming hazard as the --experimental scanner fix above
      // (CLI-1957 review): `--password --yes=false` parses under pflag as
      // `--password`'s VALUE being the literal string "--yes=false" — `--yes` was
      // never actually Changed — so SUPABASE_YES=1 must still auto-confirm the
      // history update rather than a scanner wrongly reading an explicit
      // `--yes=false` here.
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
        yield* legacyDbPull(flags());
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
    // Go's structured-dump path returns before writing a migration or touching
    // schema_migrations (pull.go:49-61), so the envelope must not claim a repair.
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
      // Go checks `usePgDelta` before `EXPERIMENTAL` (pull.go:47-50): declarative
      // export must still run normally even when --experimental is also set.
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
      // viper's bound-pflag precedence: a SET pflag value wins over AutomaticEnv
      // regardless of whether it's true or false, so `--experimental=false` must NOT
      // be overridden by a truthy `SUPABASE_EXPERIMENTAL` — the pull proceeds as
      // normal instead of hitting the retirement error (CLI-1957).
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
        yield* legacyDbPull(flags());
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
      // Both pflag/cobra (apps/cli-go's pinned cobra/pflag) and this CLI's own lexer
      // (effect/unstable/cli/internal/lexer.ts, `argv.indexOf("--")`) stop parsing
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
      // whichever Set() call happened LAST, verified empirically against the pinned
      // apps/cli-go cobra@v1.10.2/pflag@v1.0.10/viper@v1.21.0 versions. A resolver that
      // only checks "does any pre-terminator token say false" gets this ordering
      // backwards and would incorrectly skip delegating to Go (CLI-1957 review).
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
      // normally instead of falling back to SUPABASE_EXPERIMENTAL=true (CLI-1957 review).
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
    // Go loads supabase/.env via godotenv before reading EXPERIMENTAL_PG_DELTA
    // (config.go), so a project .env must select pg-delta even when the shell
    // env doesn't set it. The handler reads it via toml.envLookup, not process.env.
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

  it.effect("db pull --local provisions a local-target shadow and uses the target override", () => {
    // Go derives the shadow targetLocal from utils.IsLocalDatabase and substitutes
    // the declarative contrib_regression target override (diff.go:190,196-197);
    // the native handler must pass targetLocal and honor shadow.targetUrlOverride.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
      shadowTargetOverride: "postgres://postgres:postgres@127.0.0.1:54320/contrib_regression",
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ local: Option.some(true) }));
      expect(s.provisionCalls[0]?.targetLocal).toBe(true);
      // A local target prints the local wording (Go's `IsLocalDatabase` branch in
      // `ConnectByConfigStream`, `internal/utils/connect.go:344-346`).
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
      // Go globs `<timestamp>_*.sql` for the repair and fails with ErrNotExist when
      // the name has a path separator (the file is nested), so the native path must
      // not silently upsert an empty-version migration-history row.
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
      // (`20250101000000_backfill.sql`) matches the migration regex, but Go's
      // repair glob `<generated>_*.sql` never crosses the `/`, so it misses and
      // fails. Anchoring on the generated timestamp must reject this rather than
      // upserting the user's nested timestamp as applied.
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
    // Regression: json/stream-json layers fail every prompt as non-interactive,
    // so the history-update prompt must be skipped (Go default = yes) instead of
    // failing the command before the structured success payload is emitted.
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      // no --yes
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.historyUpserts.length).toBe(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ remoteHistoryUpdated: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // Go loads the project ref before LoadConfig on the linked path, merging the
    // matching [remotes.<ref>] block before experimental.pgdelta.enabled is read
    // (flags/db_url.go:87-97). Base config disables pg-delta; the remote override
    // enables it, so the migration-style pull must pick the pg-delta engine.
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
      // The resolved ref is forwarded through the strategy so the selected
      // implementation can build the remote-merged shadow baseline.
      expect(s.engineCalls[0]?.projectRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("retries the migration-style diff through the IPv4 pooler on an IPv6 error", () => {
    // Go wraps the linked diff with PoolerFallbackConfig and retries against the
    // IPv4 pooler when the direct host is unreachable over IPv6 from the container
    // (internal/db/pull/pull.go, diffRemoteSchema). The first edge run fails with
    // an IPv6 connectivity error; the retry succeeds and the migration is written.
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
      expect(streamText(s.out, "stderr")).toContain("does not support IPv6");
      expect(streamText(s.out, "stderr")).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(2);
      expect(streamText(s.out, "stderr")).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("retries the declarative export through the IPv4 pooler on an IPv6 error", () => {
    // Go's pullDeclarativePgDelta retries DeclarativeExportPgDelta through the
    // pooler in the same IPv6 scenario (internal/db/pull/pull.go).
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
        `Declarative schema written to ${join("supabase", "database")}\n`,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an IPv6 diff error with no pooler available surfaces the original error", () => {
    // Go's PoolerFallbackConfig returns ok=false when the pooler can't be resolved,
    // and the caller surfaces the ORIGINAL diff error rather than a retry error.
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
    // without consulting the pooler (Go's IsIPv6ConnectivityError gate).
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
});
