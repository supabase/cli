import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
} from "effect";

import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { cliConfigProviderLayer } from "../../../shared/config/cli-config-provider.layer.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type { ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnectError, DbCopyError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import type { InspectReportFlags } from "./report.command.ts";
import { inspectReport } from "./report.handler.ts";
import { REPORT_QUERIES, reportIgnoreSchemas, wrapReportQuery } from "./report.queries.ts";

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
  return yield* fs.makeTempDirectory({ prefix });
});

/** A layer whose backing directory is a fresh temp dir, created when the layer is built. */
function tempDirLayer<S>(
  prefix: string,
  make: (dir: string) => Layer.Layer<S>,
): Layer.Layer<S, PlatformError.PlatformError> {
  return Layer.unwrap(Effect.map(tempDir(prefix), make)).pipe(Layer.provide(BunServices.layer));
}

function mockResolver(opts: { conn?: PgConnInput; isLocal?: boolean; fails?: boolean } = {}) {
  let resolveInput: unknown;
  const layer = Layer.succeed(DbConfigResolver, {
    resolve: (flags) => {
      resolveInput = flags;
      if (opts.fails === true) {
        return Effect.fail(new DbConfigLoadError({ message: "cannot load config" }));
      }
      return Effect.succeed({
        conn: opts.conn ?? LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
      } satisfies ResolvedDbConfig);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get resolveInput() {
      return resolveInput;
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
  /** Raw CLI args slice, used to detect which flags were explicitly passed. */
  cliArgs?: ReadonlyArray<string>;
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
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    telemetry.layer,
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    opts.workdir === undefined
      ? tempDirLayer("supabase-report-workdir-", (workdir) => mockCommandSettings({ workdir }))
      : mockCommandSettings({ workdir: opts.workdir }),
    opts.cwd === undefined
      ? tempDirLayer("supabase-report-cwd-", (cwd) => mockRuntimeInfo({ cwd }))
      : mockRuntimeInfo({ cwd: opts.cwd }),
    mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false }),
    BunServices.layer,
    cliConfigProviderLayer,
  );
  return { layer, out, resolver, connection, telemetry };
}

const flags = (over: Partial<InspectReportFlags> = {}): InspectReportFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
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
  const dir = path.join(base, entries[0]!);
  return { dir, files: yield* fs.readDirectory(dir) };
});

describe("inspect report", () => {
  it.effect("writes one CSV per inspect query for the linked project", () => {
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

  it.effect("inspects the local database with --local", () => {
    const { layer, resolver } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--local"],
    });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base, local: true }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.effect("inspects a custom database with --db-url and labels the diagnostic 'remote'", () => {
    const { layer, resolver, out } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      isLocal: false,
      cliArgs: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base, dbUrl: Option.some("postgres://x") }));
      expect(Option.isSome((resolver.resolveInput as { dbUrl: Option.Option<string> }).dbUrl)).toBe(
        true,
      );
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  it.effect("inspects the linked project by default when no connection flag is set", () => {
    const { layer, resolver } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("linked");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects more than one of --db-url/--linked/--local", () => {
    const { layer } = setupReport({ cliArgs: ["--linked", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectReport(flags({ linked: true, local: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("are set none of the others can be");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("--local=false is Changed and routes to local (not linked)", () => {
    const { layer, resolver } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--local=false"],
    });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base, local: false }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--linked --local=false raises the mutual-exclusion error", () => {
    const { layer } = setupReport({ cliArgs: ["--linked", "--local=false"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        inspectReport(flags({ linked: true, local: false, outputDir: "." })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("are set none of the others can be");
        expect(causeText).toContain("[linked local]");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("--linked routes to linked", () => {
    const { layer, resolver } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--linked"],
    });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base, linked: true }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("linked");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports on the project given via --project-ref on the default linked path", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver } = setupReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const base = yield* tempDir("supabase-report-out-");
      yield* inspectReport(flags({ outputDir: base, projectRef: Option.some(FLAG_REF) }));
      const resolveInput = resolver.resolveInput as {
        connType: string;
        linkedProjectRef: Option.Option<string>;
      };
      expect(resolveInput.connType).toBe("linked");
      expect(resolveInput.linkedProjectRef).toEqual(Option.some(FLAG_REF));
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver } = setupReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--local"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        inspectReport(flags({ local: true, projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(resolver.resolveInput).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "prints connect + running + saved progress to stderr and the rules table to stdout",
    () => {
      const { layer, out } = setupReport({ csvs: DEFAULT_RULE_CSVS, isLocal: true });
      return Effect.gen(function* () {
        const base = yield* tempDir("supabase-report-out-");
        yield* inspectReport(flags({ outputDir: base }));
        expect(out.stderrText).toContain("Connecting to local database...");
        expect(out.stderrText).toContain("Running queries...");
        expect(out.stderrText).toContain("Reports saved to ");
        expect(out.stderrText).toContain("Loading default rules...");
        expect(out.stdoutText).toContain("RULE");
        expect(out.stdoutText).toContain("STATUS");
        expect(out.stdoutText).toContain("MATCHES");
        expect(out.stdoutText).toContain("No old locks");
      }).pipe(Effect.provide(layer));
    },
  );

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
        expect(causeText).toContain("invalid keys: typo");
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
      const success = out.messages.find((m) => m.type === "success");
      const data = (
        success as { data?: { files?: Array<unknown>; outputDir?: string; rules?: Array<unknown> } }
      ).data;
      expect(data?.files?.length).toBe(14);
      expect(typeof data?.outputDir).toBe("string");
      expect(data?.rules?.length).toBe(13);
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
