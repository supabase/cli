import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import {
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import { legacyDbPull } from "./pull.handler.ts";

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [{ path: "schemas/public/t.sql", order: 0, statements: 1, sql: "create table t ();" }],
});

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly remoteVersions?: ReadonlyArray<string>;
  readonly edgeStdout?: string; // diff SQL or declarative export JSON
  readonly stdinIsTty?: boolean;
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
  // Raw argv seen by the handler (CliArgs). Only consulted when both
  // `--declarative` and `--use-pg-delta` are present, to replay pflag's
  // last-occurrence-wins ordering; defaults to empty.
  readonly args?: ReadonlyArray<string>;
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
    provisionShadow: ({ mode, usePgDelta, targetLocal, projectRef }) => {
      provisionCalls.push({ mode, usePgDelta, targetLocal, projectRef });
      return Effect.succeed({
        container: "shadow-1",
        sourceUrl: "postgres://postgres:postgres@127.0.0.1:54320/postgres",
        targetUrlOverride: opts.shadowTargetOverride,
      });
    },
    removeShadowContainer: (container) =>
      Effect.sync(() => {
        removedContainers.push(container);
      }),
  });

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

  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: () => Effect.die("runStream unused"),
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

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    edge,
    docker,
    dbConnection,
    resolver,
    proxy,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyPgDeltaSslProbe, { requireSsl: () => Effect.succeed(false) }),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockRuntimeInfo(),
    BunServices.layer,
  );

  return {
    layer,
    out,
    provisionCalls,
    removedContainers,
    proxyCalls,
    proxyCaptureCalls,
    historyUpserts,
    execLog,
    poolerFallbackCalls,
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

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");
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
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ diffEngine: Option.some("pg-delta") }));
      const dir = join(tmp.current, "supabase", "migrations");
      expect(existsSync(join(dir, `${"20240101000000"}_local.sql`))).toBe(true);
      // A new timestamped remote_schema migration was written.
      expect(streamText(s.out, "stderr")).toContain("Schema written to");
      expect(s.historyUpserts.length).toBe(1);
      expect(streamText(s.out, "stdout")).toContain("Finished supabase db pull.");
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
      expect(streamText(s.out, "stderr")).toContain("Schema written to");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pull --declarative exports declarative files (no migration)", () => {
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ declarative: Option.some(true) }));
      expect(streamText(s.out, "stderr")).toContain("Preparing declarative schema export");
      expect(streamText(s.out, "stderr")).toContain("Declarative schema written to");
      expect(
        existsSync(join(tmp.current, "supabase", "database", "schemas", "public", "t.sql")),
      ).toBe(true);
      expect(s.provisionCalls[0]?.mode).toBe("declarative");
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
        expect(streamText(s.out, "stderr")).toContain("Declarative schema written to");
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
      expect(s.provisionCalls[0]?.mode).toBe("declarative");
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

  it.effect("an initial pull with no local migrations delegates the dump to Go (migra)", () => {
    const s = setup(tmp.current, { remoteVersions: [] });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.proxyCalls).toHaveLength(1);
      expect(s.proxyCalls[0]?.args[0]).toBe("db");
      expect(s.proxyCalls[0]?.args[1]).toBe("pull");
      expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial pull in json mode emits a structured envelope (delegated output)", () => {
    // Regression: the initial-migra delegate inherited stdout and returned without
    // output.success, so machine-mode callers got the Go child's human output
    // instead of a JSON envelope (CLI-1546). Now the child's stdout is captured and
    // a structured payload is emitted instead.
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: [],
      delegateStdout: "Schema written to supabase/migrations/x.sql\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(1);
      // The delegated child runs with a non-TTY stdin so its history-update prompt
      // takes Go's default (true) without blocking the JSON caller; the child then
      // updates the history, so the envelope reports remoteHistoryUpdated: true.
      expect(s.proxyCaptureCalls[0]?.stdin).toBe("ignore");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        declarative: false,
        schemaWritten: null,
        remoteHistoryUpdated: true,
        engine: "migra",
      });
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

  it.effect("SUPABASE_EXPERIMENTAL delegates the structured-dump pull to Go", () => {
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
    }).pipe(Effect.provide(s.layer));
  });

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

  it.effect("the global --experimental flag delegates the structured-dump pull to Go", () => {
    // viper resolves EXPERIMENTAL from the pflag OR the env var; the flag form
    // (`supabase --experimental db pull`) must delegate just like the env form.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.proxyCalls).toHaveLength(1);
      expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    }).pipe(Effect.provide(s.layer));
  });

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

  it.effect("a project supabase/.env enabling pg-delta selects the pg-delta engine", () => {
    // Go loads supabase/.env via godotenv before reading EXPERIMENTAL_PG_DELTA
    // (config.go), so a project .env must select pg-delta even when the shell
    // env doesn't set it. The handler reads it via toml.envLookup, not process.env.
    seedMigration(tmp.current, "20240101000000");
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL_PG_DELTA=true\n");
    const s = setup(tmp.current, {
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags());
      expect(s.provisionCalls[0]?.usePgDelta).toBe(true);
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
      edgeStdout: "create table remote ();\n",
      yes: true,
      resolvedRef: "abcdefghijklmnopqrst",
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(flags({ linked: Option.some(true) }));
      expect(s.provisionCalls[0]?.usePgDelta).toBe(true);
      // The resolved ref is forwarded to the shadow so the `db __shadow` child
      // merges the same `[remotes.<ref>]` override into the shadow baseline.
      expect(s.provisionCalls[0]?.projectRef).toBe("abcdefghijklmnopqrst");
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
      edgeStdout: "create table remote ();\n",
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbPull(
        flags({ linked: Option.some(true), diffEngine: Option.some("pg-delta") }),
      );
      expect(streamText(s.out, "stderr")).toContain("does not support IPv6");
      expect(streamText(s.out, "stderr")).toContain("Retrying via the IPv4 connection pooler");
      expect(s.edgeRunCount).toBe(2);
      expect(streamText(s.out, "stderr")).toContain("Schema written to");
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
      expect(s.edgeRunCount).toBe(2);
      expect(streamText(s.out, "stderr")).toContain("Declarative schema written to");
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
      expect(s.edgeRunCount).toBe(1);
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
      expect(s.edgeRunCount).toBe(1);
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
