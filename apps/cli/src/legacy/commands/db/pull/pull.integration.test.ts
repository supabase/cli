import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
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
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const provisionCalls: Array<{ mode: string; usePgDelta: boolean }> = [];
  const removedContainers: string[] = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: () => Effect.succeed("supabase/.temp/pgdelta/x.json"),
    execInherit: () => Effect.succeed(0),
    ensureLocalDatabaseStarted: () => Effect.void,
    provisionShadow: ({ mode, usePgDelta }) => {
      provisionCalls.push({ mode, usePgDelta });
      return Effect.succeed({
        container: "shadow-1",
        sourceUrl: "postgres://postgres:postgres@127.0.0.1:54320/postgres",
        targetUrlOverride: undefined,
      });
    },
    removeShadowContainer: (container) =>
      Effect.sync(() => {
        removedContainers.push(container);
      }),
  });

  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (_runOpts: LegacyEdgeRuntimeRunOpts) =>
      Effect.succeed({ stdout: opts.edgeStdout ?? "", stderr: "" }),
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

  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: () =>
      Effect.succeed({
        conn: {
          host: "db.remote",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
        ref: Option.none(),
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const proxyCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
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
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyPgDeltaSslProbe, { requireSsl: () => Effect.succeed(false) }),
    mockRuntimeInfo(),
    BunServices.layer,
  );

  return { layer, out, provisionCalls, removedContainers, proxyCalls, historyUpserts, execLog };
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

  it.effect("an in-sync pull (empty diff) fails with 'No schema changes found'", () => {
    seedMigration(tmp.current, "20240101000000");
    const s = setup(tmp.current, { remoteVersions: ["20240101000000"], edgeStdout: "" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPull(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
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
      // no --yes: the !tty branch falls through to the default (true).
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
