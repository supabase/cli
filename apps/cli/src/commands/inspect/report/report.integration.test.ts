import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
} from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockTelemetryStateTracked,
  unverifiedTargetBanner,
  useTempWorkdir,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  realDbConfigResolver,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbConnectError, DbCopyError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import type { InspectReportFlags } from "./report.command.ts";
import { inspectReport } from "./report.handler.ts";
import { REPORT_QUERIES, reportIgnoreSchemas, wrapReportQuery } from "./report.queries.ts";
import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
import { branchRow, warningsOf } from "../../../../tests/helpers/remote-selection.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

// Maps each query's wrapped COPY statement back to its file name so the mocked `copyToCsv`
// can return the right canned CSV.
const WRAPPED_TO_FILE = new Map<string, string>();
for (const { fileName, sql } of REPORT_QUERIES) {
  WRAPPED_TO_FILE.set(wrapReportQuery(sql, reportIgnoreSchemas(), "'postgres'"), fileName);
}

const tempDir = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

/** A layer whose backing directory is a fresh temp dir, created when the layer is built. */
function tempDirLayer<S>(
  prefix: string,
  make: (dir: string) => Layer.Layer<S>,
): Layer.Layer<S, PlatformError.PlatformError> {
  return Layer.unwrap(Effect.map(tempDir(prefix), make)).pipe(Layer.provide(BunServices.layer));
}

function mockResolver(opts: { conn?: PgConnInput; isLocal?: boolean; fails?: boolean } = {}) {
  let connectionInput: DbConnectionInput | undefined;
  const layer = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      connectionInput = input;
      if (opts.fails === true) {
        return Effect.fail(new DbConfigLoadError({ message: "cannot load config" }));
      }
      return Effect.succeed({
        conn: opts.conn ?? LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get connectionInput() {
      return connectionInput;
    },
  };
}

function mockReportConnection(opts: {
  csvs?: Record<string, string>;
  connectFails?: boolean;
  copyFails?: boolean;
}) {
  const copiedSql: Array<string> = [];
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      if (opts.connectFails === true) {
        return Effect.fail(
          new DbConnectError({ message: "failed to connect to postgres: refused" }),
        );
      }
      return Effect.succeed({
        exec: () => Effect.void,
        execBatch: () => Effect.void,
        extensionExists: () => Effect.succeed(false),
        query: () => Effect.succeed([]),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        copyToCsv: (sql: string) => {
          copiedSql.push(sql);
          if (opts.copyFails === true) {
            return Effect.fail(new DbCopyError({ message: "failed to copy output: boom" }));
          }
          const fileName = WRAPPED_TO_FILE.get(sql) ?? "unknown";
          const text = opts.csvs?.[`${fileName}.csv`] ?? "";
          return Effect.succeed(new TextEncoder().encode(text));
        },
      });
    },
  });
  return {
    layer,
    get copiedSql() {
      return copiedSql;
    },
  };
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  conn?: PgConnInput;
  isLocal?: boolean;
  csvs?: Record<string, string>;
  resolveFails?: boolean;
  connectFails?: boolean;
  copyFails?: boolean;
  stdoutIsTty?: boolean;
  cwd?: string;
  workdir?: string;
  /** The ref `SUPABASE_PROJECT_ID` supplies to the real project-ref resolver. */
  projectId?: string;
  /** Raw CLI args slice, used to detect which flags were explicitly passed. */
  cliArgs?: ReadonlyArray<string>;
  commandPath?: ReadonlyArray<string>;
  /** Runs the real `DbConfigResolver` against `workdir`. */
  realLayers?: boolean;
}

function setupReport(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({
    conn: opts.conn,
    isLocal: opts.isLocal,
    fails: opts.resolveFails,
  });
  const connection = mockReportConnection({
    csvs: opts.csvs,
    connectFails: opts.connectFails,
    copyFails: opts.copyFails,
  });
  const telemetry = mockTelemetryStateTracked();
  const projectId = opts.projectId === undefined ? Option.none() : Option.some(opts.projectId);
  const cliSettings = (
    opts.workdir === undefined
      ? tempDirLayer("supabase-report-workdir-", (workdir) =>
          mockCommandSettings({ workdir, projectId }),
        )
      : mockCommandSettings({ workdir: opts.workdir, projectId })
  ).pipe(Layer.orDie);
  const runtimeInfo = (
    opts.cwd === undefined
      ? tempDirLayer("supabase-report-cwd-", (cwd) => mockRuntimeInfo({ cwd }))
      : mockRuntimeInfo({ cwd: opts.cwd })
  ).pipe(Layer.orDie);
  const api = mockCommandPlatformApi({
    handler: (request) => Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")])),
  });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false }),
      runtimeInfo,
      telemetry: telemetry.layer,
      cliArgs: opts.cliArgs,
      commandPath: opts.commandPath,
    }),
    opts.realLayers !== true || opts.workdir === undefined
      ? resolver.layer
      : realDbConfigResolver({
          workdir: opts.workdir,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        }),
    connection.layer,
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, false),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    configValuesLayer(),
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord(
        opts.realLayers === true ? { SUPABASE_ACCESS_TOKEN: VALID_TOKEN } : {},
        { preserveEmptyStrings: true },
      ),
    ),
  );
  return {
    layer,
    out,
    resolver,
    connection,
    telemetry,
    branchRequests: api.requests,
    warnings: () => warningsOf(out),
  };
}

const flags = (over: Partial<InspectReportFlags> = {}): InspectReportFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none<string>(),
  outputDir: over.outputDir ?? ".",
});

// Real column headers for each query, so column lookups resolve as they would against
// Postgres. `locks.csv` has an old (rule 1 fail) but granted (rule 2 pass) row.
const DEFAULT_RULE_CSVS: Record<string, string> = {
  "locks.csv": "stmt,age,granted\nLOCK_A,00:05:00,t\n",
  "unused_indexes.csv": "index\n",
  "index_stats.csv": "name,table,columns\n",
  "db_stats.csv": "name,index_hit_rate,table_hit_rate\npostgres,0.99,0.99\n",
  "table_stats.csv": "name,seq_scans,estimated_row_count\n",
  "vacuum_stats.csv": "name,rowcount,dead_rowcount,expect_autovacuum,last_autovacuum,last_vacuum\n",
  "replication_slots.csv": "slot_name,active\n",
  "blocking.csv": "blocked_pid\n",
  "long_running_queries.csv": "pid\n",
  "bloat.csv": "name,bloat\n",
};

const localDateFolder = Effect.map(DateTime.now, (now) => {
  const local = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
});

const dateFolderContents = Effect.fnUntraced(function* (base: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* Effect.filter(yield* fs.readDirectory(base), (name) =>
    Effect.map(fs.stat(path.join(base, name)), (info) => info.type === "Directory"),
  );
  expect(entries.length).toBe(1);
  const dir = path.join(base, entries[0] ?? "");
  return { dir, files: yield* fs.readDirectory(dir) };
});

describe("inspect report", () => {
  const targetWorkdir = useTempWorkdir("supabase-inspect-report-target-");

  it.effect("writes one CSV per inspect query", () => {
    const { layer, connection } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    const prevUmask = process.umask(0);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      const { dir, files } = yield* dateFolderContents(base);
      expect(files.length).toBe(14);
      expect(files).toContain("db_stats.csv");
      expect(files).toContain("unused_indexes.csv");
      expect(files).not.toContain("db-stats.csv");
      expect(connection.copiedSql.length).toBe(14);
      expect(
        connection.copiedSql.every(
          (s) => s.startsWith("COPY (") && s.endsWith("TO STDOUT WITH CSV HEADER"),
        ),
      ).toBe(true);
      expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o755);
      expect((yield* fs.stat(path.join(dir, "db_stats.csv"))).mode & 0o777).toBe(0o644);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => process.umask(prevUmask))));
  });

  it.effect("inspects a custom database with --remote=<url>", () => {
    const { layer, resolver, out } = setupReport({ csvs: DEFAULT_RULE_CSVS, isLocal: false });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(
        flags({
          outputDir: base,
          remote: Option.some({ _tag: "DbUrl", url: "postgres://x" } as const),
        }),
      );
      const target = resolver.connectionInput?.target;
      expect(target?.kind === "db-url" ? Redacted.value(target.url) : undefined).toBe(
        "postgres://x",
      );
      expect(out.stderrText).not.toContain("Connecting to");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a bare --remote routes to the linked project and announces it", () => {
    const { layer, resolver, out, warnings } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      projectId: VALID_REF,
    });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(
        flags({ outputDir: base, remote: Option.some({ _tag: "Linked" } as const) }),
      );
      expect(resolver.connectionInput?.target).toMatchObject({ kind: "linked", ref: VALID_REF });
      expect(out.stderrText).toContain(unverifiedTargetBanner());
      expect(warnings()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  describeDbTargetSelection("inspect report", {
    dbUrl: true,
    workdir: () => targetWorkdir.current,
    attempt: ({ workdir, args, target }) => {
      const ctx = setupReport({
        csvs: DEFAULT_RULE_CSVS,
        workdir,
        projectId: VALID_REF,
        cliArgs: args,
        commandPath: ["inspect", "report"],
      });
      return {
        layer: ctx.layer,
        out: ctx.out,
        run: inspectReport(flags({ ...target, outputDir: workdir })),
        target: () => ctx.resolver.connectionInput?.target,
        branchLookups: () => ctx.branchRequests,
        apiRequests: () => ctx.branchRequests,
      };
    },
  });

  it.effect("prints running + saved progress to stderr and the rules table to stdout", () => {
    const { layer, out } = setupReport({ csvs: DEFAULT_RULE_CSVS, isLocal: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(out.stderrText).not.toContain("Connecting to");
      expect(out.stderrText).toContain("Running queries...");
      expect(out.stderrText).toContain("Reports saved to ");
      expect(out.stderrText).toContain("Loading default rules...");
      expect(out.stdoutText).toContain("RULE");
      expect(out.stdoutText).toContain("STATUS");
      expect(out.stdoutText).toContain("MATCHES");
      expect(out.stdoutText).toContain("No old locks");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows a passing rule as ✔/- and a failing rule with its message and matches", () => {
    const { layer, out } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(out.stdoutText).toContain("There is at least one lock older than 2 minutes");
      expect(out.stdoutText).toContain("LOCK_A");
      expect(out.stdoutText).toContain("✔");
      expect(out.stdoutText).toContain("No duplicate indexes");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "custom config.toml rules replace the defaults and suppress 'Loading default rules...'",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* tempDir("supabase-report-out-");
        const workdir = yield* tempDir("supabase-report-workdir-");
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          [
            "[[experimental.inspect.rules]]",
            "query = \"SELECT COUNT(*) FROM `locks.csv` WHERE granted = 'f'\"",
            'name = "Custom rule"',
            'pass = "good"',
            'fail = "bad"',
            "",
          ].join("\n"),
        );
        const { layer, out } = setupReport({
          workdir,
          csvs: { "locks.csv": "stmt,granted\nA,t\n" },
        });
        yield* inspectReport(flags({ outputDir: base })).pipe(Effect.provide(layer));
        expect(out.stderrText).not.toContain("Loading default rules...");
        expect(out.stdoutText).toContain("Custom rule");
        expect(out.stdoutText).toContain("bad");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "keeps a rule's literal env(VAR) when the shell sets VAR empty, even if supabase/.env defines it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* tempDir("supabase-report-out-");
        const workdir = yield* tempDir("supabase-report-workdir-");
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          [
            "[[experimental.inspect.rules]]",
            "query = \"SELECT COUNT(*) FROM `locks.csv` WHERE granted = 'f'\"",
            'name = "Env rule"',
            'pass = "good"',
            'fail = "env(REPORT_INTEG_X)"',
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(workdir, "supabase", ".env"),
          "REPORT_INTEG_X=fromfile\n",
        );
        const { layer, out } = setupReport({
          workdir,
          csvs: { "locks.csv": "stmt,granted\nA,t\n" },
        });
        yield* withEnvVar(
          "REPORT_INTEG_X",
          "",
          inspectReport(flags({ outputDir: base })).pipe(Effect.provide(layer)),
        );
        expect(out.stdoutText).toContain("Env rule");
        expect(out.stdoutText).toContain("env(REPORT_INTEG_X)");
        expect(out.stdoutText).not.toContain("fromfile");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("surfaces a malformed rule query as the STATUS cell without failing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* tempDir("supabase-report-out-");
      const workdir = yield* tempDir("supabase-report-workdir-");
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        [
          "[[experimental.inspect.rules]]",
          // `nope.csv` doesn't exist, so this surfaces as the rule's STATUS cell.
          'query = "SELECT COUNT(*) FROM `nope.csv`"',
          'name = "Broken rule"',
          'pass = "ok"',
          'fail = "bad"',
          "",
        ].join("\n"),
      );
      const { layer, out } = setupReport({ workdir, csvs: DEFAULT_RULE_CSVS });
      const exit = yield* Effect.exit(
        inspectReport(flags({ outputDir: base })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toContain("Broken rule");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("aborts on a malformed config.toml before connecting or writing any CSV", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* tempDir("supabase-report-out-");
      const workdir = yield* tempDir("supabase-report-workdir-");
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        [
          "[[experimental.inspect.rules]]",
          'query = "SELECT 1"',
          'name = "r"',
          'pass = "ok"',
          'fail = "bad"',
          'typo = "x"',
          "",
        ].join("\n"),
      );
      const { layer, connection } = setupReport({ workdir });
      const exit = yield* Effect.exit(
        inspectReport(flags({ outputDir: base })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("unknown keys: typo");
      }
      // `base` is the pre-created temp dir itself; no dated subfolder is created.
      expect(connection.copiedSql.length).toBe(0);
      expect((yield* fs.readDirectory(base)).length).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("emits a structured result and writes CSVs but no table in json mode", () => {
    const { layer, out } = setupReport({ format: "json", csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(out.stdoutText).toBe("");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "inspect report" }),
      );
      const data = out.messages.find((m) => m.type === "success")?.data;
      expect(data?.files).toHaveLength(14);
      expect(typeof data?.outputDir).toBe("string");
      expect(data?.rules).toHaveLength(13);
      expect((yield* dateFolderContents(base)).files.length).toBe(14);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("streams the structured result in stream-json mode", () => {
    const { layer, out } = setupReport({ format: "stream-json", csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "inspect report" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "aborts with a failed-to-mkdir error when the output directory cannot be created",
    () => {
      const { layer } = setupReport();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Point --output-dir at a regular file so mkdir of `<file>/<date>` fails.
        const fileAsDir = path.join(yield* tempDir("supabase-report-out-"), "afile");
        yield* fs.writeFileString(fileAsDir, "x");
        const exit = yield* Effect.exit(inspectReport(flags({ outputDir: fileAsDir })));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("failed to mkdir");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("aborts with a copy error when COPY fails", () => {
    const { layer } = setupReport({ copyFails: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      const exit = yield* Effect.exit(inspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to copy output");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("aborts with a failed-to-create-output-file error when a CSV cannot be written", () => {
    const { layer } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* tempDir("supabase-report-out-");
      // Pre-creates `bloat.csv` as a directory so the file write fails (EISDIR) while the
      // recursive mkdir still succeeds.
      yield* fs.makeDirectory(path.join(base, yield* localDateFolder, "bloat.csv"), {
        recursive: true,
      });
      const exit = yield* Effect.exit(inspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to create output file");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("aborts when the connection fails", () => {
    const { layer } = setupReport({ connectFails: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      const exit = yield* Effect.exit(inspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("aborts when resolution fails", () => {
    const { layer } = setupReport({ resolveFails: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      const exit = yield* Effect.exit(inspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("cannot load config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a relative --output-dir under the process CWD", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* tempDir("supabase-report-cwd-");
      const { layer } = setupReport({ csvs: DEFAULT_RULE_CSVS, cwd });
      yield* inspectReport(flags({ outputDir: "reports" })).pipe(Effect.provide(layer));
      const { files } = yield* dateFolderContents(path.join(cwd, "reports"));
      expect(files.length).toBe(14);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("uses an absolute --output-dir as-is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* tempDir("supabase-report-out-");
      const cwd = yield* tempDir("supabase-report-cwd-");
      const { layer } = setupReport({ csvs: DEFAULT_RULE_CSVS, cwd });
      yield* inspectReport(flags({ outputDir: base })).pipe(Effect.provide(layer));
      expect((yield* dateFolderContents(base)).files.length).toBe(14);
      expect((yield* fs.readDirectory(cwd)).length).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("renders the path in bold when stdout is a TTY", () => {
    const { layer, out } = setupReport({ csvs: DEFAULT_RULE_CSVS, stdoutIsTty: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(out.stderrText).toContain("\x1b[1m");
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry on success", () => {
    const { layer, telemetry } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry even when the command fails", () => {
    const { layer, telemetry } = setupReport({ resolveFails: true });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* Effect.exit(inspectReport(flags({ outputDir: base })));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("inspect report through the real database-config resolver", () => {
  const tempRoot = useTempWorkdir("supabase-inspect-report-int-");

  it.effect("mints a login role for the linked project and writes every CSV", () => {
    const { layer, connection } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      isLocal: false,
      cliArgs: ["inspect", "report", `--remote=${VALID_REF}`],
      workdir: tempRoot.current,
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* inspectReport(
        flags({ outputDir: base, remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const) }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      const { files } = yield* dateFolderContents(base);
      expect(files).toHaveLength(14);
      expect(connection.copiedSql).toHaveLength(14);
      assertPermissionDrift({
        command: "inspect report",
        activeFlags: { remote: VALID_REF, "output-dir": true },
        requests: asRecordedRequests(requests),
        exact: true,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("makes no Management API request for the default local target", () => {
    const { layer, connection } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["inspect", "report"],
      workdir: tempRoot.current,
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* stubManagementApi(requests, () => undefined);
      yield* inspectReport(flags({ outputDir: base }));
      const { files } = yield* dateFolderContents(base);
      expect(files).toHaveLength(14);
      expect(connection.copiedSql).toHaveLength(14);
      expect(requests).toEqual([]);
      assertPermissionDrift({
        command: "inspect report",
        activeFlags: { "output-dir": true },
        requests: [],
        exact: true,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
