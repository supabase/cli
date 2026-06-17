import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import type { LegacyResolvedDbConfig } from "../../../shared/legacy-db-config.types.ts";
import {
  LegacyDbConnectError,
  LegacyDbCopyError,
} from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyInspectReportFlags } from "./report.command.ts";
import { legacyInspectReport } from "./report.handler.ts";
import {
  LEGACY_REPORT_QUERIES,
  legacyReportIgnoreSchemas,
  legacyWrapReportQuery,
} from "./report.queries.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

// Map each query's wrapped COPY statement back to its file name so the mocked
// `copyToCsv` can return the right canned CSV.
const WRAPPED_TO_FILE = new Map<string, string>();
for (const { fileName, sql } of LEGACY_REPORT_QUERIES) {
  WRAPPED_TO_FILE.set(
    legacyWrapReportQuery(sql, legacyReportIgnoreSchemas(), "'postgres'"),
    fileName,
  );
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockResolver(opts: { conn?: LegacyPgConnInput; isLocal?: boolean; fails?: boolean } = {}) {
  let resolveInput: unknown;
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags) => {
      resolveInput = flags;
      if (opts.fails === true) {
        return Effect.fail(new LegacyDbConfigLoadError({ message: "cannot load config" }));
      }
      return Effect.succeed({
        conn: opts.conn ?? LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
      } satisfies LegacyResolvedDbConfig);
    },
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
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () => {
      if (opts.connectFails === true) {
        return Effect.fail(
          new LegacyDbConnectError({ message: "failed to connect to postgres: refused" }),
        );
      }
      return Effect.succeed({
        exec: () => Effect.void,
        extensionExists: () => Effect.succeed(false),
        query: () => Effect.succeed([]),
        copyToCsv: (sql: string) => {
          copiedSql.push(sql);
          if (opts.copyFails === true) {
            return Effect.fail(new LegacyDbCopyError({ message: "failed to copy output: boom" }));
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
  conn?: LegacyPgConnInput;
  isLocal?: boolean;
  csvs?: Record<string, string>;
  resolveFails?: boolean;
  connectFails?: boolean;
  copyFails?: boolean;
  stdoutIsTty?: boolean;
  cwd?: string;
  workdir?: string;
  /** Raw CLI args slice — drives Changed-based flag detection (cobra parity). */
  cliArgs?: ReadonlyArray<string>;
}

function setupLegacyReport(opts: SetupOpts = {}) {
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const workdir = opts.workdir ?? tempDir("supabase-report-workdir-");
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    telemetry.layer,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    mockLegacyCliConfig({ workdir }),
    mockRuntimeInfo({ cwd: opts.cwd ?? tempDir("supabase-report-cwd-") }),
    mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false }),
    BunServices.layer,
  );
  return { layer, out, resolver, connection, telemetry, workdir };
}

const flags = (over: Partial<LegacyInspectReportFlags> = {}): LegacyInspectReportFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  outputDir: over.outputDir ?? ".",
});

// One CSV per referenced file with the REAL column headers each query emits, so
// column lookups resolve exactly as they would against Postgres. `locks.csv`
// carries an old (rule 1 fail) but granted (rule 2 pass) row. Note `vacuum_stats`
// has no `tbl` column (it never did) — default rule 6 references `s.tbl` verbatim
// from Go, so it surfaces an unknown-column error as its STATUS cell.
const DEFAULT_RULE_CSVS: Record<string, string> = {
  "locks.csv": "stmt,age,granted\nLOCK_A,00:05:00,t\n",
  "unused_indexes.csv": "index\n",
  "db_stats.csv": "name,index_hit_rate,table_hit_rate\npostgres,0.99,0.99\n",
  "table_stats.csv": "name,seq_scans,estimated_row_count\n",
  "vacuum_stats.csv": "name,rowcount,expect_autovacuum,last_autovacuum,last_vacuum\n",
};

function localDateFolder(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateFolderContents(base: string): { dir: string; files: Array<string> } {
  const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
  expect(entries.length).toBe(1);
  const dir = join(base, entries[0]!.name);
  return { dir, files: readdirSync(dir) };
}

describe("legacy inspect report", () => {
  it.live("writes one CSV per inspect query for the linked project", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, connection } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      const { files } = dateFolderContents(base);
      expect(files.length).toBe(14);
      expect(files).toContain("db_stats.csv");
      expect(files).toContain("unused_indexes.csv");
      expect(files).not.toContain("db-stats.csv");
      // Every query was copied with both placeholders substituted.
      expect(connection.copiedSql.length).toBe(14);
      expect(
        connection.copiedSql.every(
          (s) => s.startsWith("COPY (") && s.endsWith("TO STDOUT WITH CSV HEADER"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects the local database with --local", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, resolver } = setupLegacyReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--local"],
    });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base, local: true }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects a custom database with --db-url and labels the diagnostic 'remote'", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, resolver, out } = setupLegacyReport({
      csvs: DEFAULT_RULE_CSVS,
      isLocal: false,
      cliArgs: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base, dbUrl: Option.some("postgres://x") }));
      expect(Option.isSome((resolver.resolveInput as { dbUrl: Option.Option<string> }).dbUrl)).toBe(
        true,
      );
      // The connect diagnostic reflects a non-local target (Go parity).
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects the linked project by default when no connection flag is set", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, resolver } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("linked");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects more than one of --db-url/--linked/--local", () => {
    const { layer } = setupLegacyReport({ cliArgs: ["--linked", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ linked: true, local: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("are set none of the others can be");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false is Changed and routes to local (not linked)", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, resolver } = setupLegacyReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--local=false"],
    });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base, local: false }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked --local=false raises the mutual-exclusion error", () => {
    const { layer } = setupLegacyReport({ cliArgs: ["--linked", "--local=false"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyInspectReport(flags({ linked: true, local: false, outputDir: "." })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("are set none of the others can be");
        expect(JSON.stringify(exit.cause)).toContain("[linked local]");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked routes to linked", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, resolver } = setupLegacyReport({
      csvs: DEFAULT_RULE_CSVS,
      cliArgs: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base, linked: true }));
      expect((resolver.resolveInput as { connType: string }).connType).toBe("linked");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "prints connect + running + saved progress to stderr and the rules table to stdout",
    () => {
      const base = tempDir("supabase-report-out-");
      const { layer, out } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS, isLocal: true });
      return Effect.gen(function* () {
        yield* legacyInspectReport(flags({ outputDir: base }));
        expect(out.stderrText).toContain("Connecting to local database...");
        expect(out.stderrText).toContain("Running queries...");
        expect(out.stderrText).toContain("Reports saved to ");
        expect(out.stderrText).toContain("Loading default rules...");
        // stdout carries the Glamour rules table.
        expect(out.stdoutText).toContain("RULE");
        expect(out.stdoutText).toContain("STATUS");
        expect(out.stdoutText).toContain("MATCHES");
        expect(out.stdoutText).toContain("No old locks");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("shows a passing rule as ✔/- and a failing rule with its message and matches", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, out } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      // Rule 1 fails (old lock): message + matched statement.
      expect(out.stdoutText).toContain("There is at least one lock older than 2 minutes");
      expect(out.stdoutText).toContain("LOCK_A");
      // Rule 2 passes (lock is granted): ✔.
      expect(out.stdoutText).toContain("✔");
      // Rule 6 references `s.tbl` (Go-verbatim) which vacuum_stats lacks → the
      // unknown-column error is shown as its STATUS cell, command still succeeds.
      expect(out.stdoutText).toContain("unknown column: tbl");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "custom config.toml rules replace the defaults and suppress 'Loading default rules...'",
    () => {
      const base = tempDir("supabase-report-out-");
      const workdir = tempDir("supabase-report-workdir-");
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "config.toml"),
        [
          "[[experimental.inspect.rules]]",
          "query = \"SELECT COUNT(*) FROM `locks.csv` WHERE granted = 'f'\"",
          'name = "Custom rule"',
          'pass = "good"',
          'fail = "bad"',
          "",
        ].join("\n"),
      );
      const { layer, out } = setupLegacyReport({
        workdir,
        csvs: { "locks.csv": "stmt,granted\nA,t\n" },
      });
      return Effect.gen(function* () {
        yield* legacyInspectReport(flags({ outputDir: base }));
        expect(out.stderrText).not.toContain("Loading default rules...");
        expect(out.stdoutText).toContain("Custom rule");
        // No-match COUNT(*) returns 0, a non-empty value → fail status for this rule.
        expect(out.stdoutText).toContain("bad");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("surfaces a malformed rule query as the STATUS cell without failing", () => {
    const base = tempDir("supabase-report-out-");
    const workdir = tempDir("supabase-report-workdir-");
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      [
        "[[experimental.inspect.rules]]",
        // References a CSV that was never produced — the provider returns no table
        // and the evaluator surfaces the error as the STATUS cell (not a failure).
        'query = "SELECT COUNT(*) FROM `nope.csv`"',
        'name = "Broken rule"',
        'pass = "ok"',
        'fail = "bad"',
        "",
      ].join("\n"),
    );
    const { layer, out } = setupLegacyReport({ workdir, csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toContain("Broken rule");
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts on a malformed config.toml before connecting or writing any CSV", () => {
    const base = tempDir("supabase-report-out-");
    const workdir = tempDir("supabase-report-workdir-");
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    // An invalid rule config (unknown key) — Go loads config in PersistentPreRun, so
    // it must abort before the DB connection and before any CSV files are written.
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
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
    const { layer, connection } = setupLegacyReport({ workdir });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("invalid keys: typo");
      }
      // No connection and no dated output folder — config validation ran first,
      // before mkdir / connect / COPY (base itself is the pre-created temp dir).
      expect(connection.copiedSql.length).toBe(0);
      expect(readdirSync(base).length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result and writes CSVs but no table in json mode", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, out } = setupLegacyReport({ format: "json", csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
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
      expect(data?.rules?.length).toBe(7);
      // CSVs are still written.
      expect(dateFolderContents(base).files.length).toBe(14);
      // No progress lines in machine mode.
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("streams the structured result in stream-json mode", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, out } = setupLegacyReport({ format: "stream-json", csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "inspect report" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts with a failed-to-mkdir error when the output directory cannot be created", () => {
    // Point --output-dir at a regular file so mkdir of `<file>/<date>` fails.
    const fileAsDir = join(tempDir("supabase-report-out-"), "afile");
    writeFileSync(fileAsDir, "x");
    const { layer } = setupLegacyReport();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: fileAsDir })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to mkdir");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts with a copy error when COPY fails", () => {
    const base = tempDir("supabase-report-out-");
    const { layer } = setupLegacyReport({ copyFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to copy output");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts with a failed-to-create-output-file error when a CSV cannot be written", () => {
    const base = tempDir("supabase-report-out-");
    // Pre-create the first CSV target (`bloat.csv`) as a DIRECTORY so the file
    // write fails (EISDIR) while mkdir (recursive, idempotent) still succeeds.
    mkdirSync(join(base, localDateFolder(), "bloat.csv"), { recursive: true });
    const { layer } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to create output file");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts when the connection fails", () => {
    const base = tempDir("supabase-report-out-");
    const { layer } = setupLegacyReport({ connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts when resolution fails", () => {
    const base = tempDir("supabase-report-out-");
    const { layer } = setupLegacyReport({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyInspectReport(flags({ outputDir: base })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("cannot load config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a relative --output-dir under the process CWD", () => {
    const cwd = tempDir("supabase-report-cwd-");
    const { layer } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS, cwd });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: "reports" }));
      const { files } = dateFolderContents(join(cwd, "reports"));
      expect(files.length).toBe(14);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses an absolute --output-dir as-is", () => {
    const base = tempDir("supabase-report-out-");
    const cwd = tempDir("supabase-report-cwd-");
    const { layer } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS, cwd });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      // Written under the absolute base, not under the CWD.
      expect(dateFolderContents(base).files.length).toBe(14);
      expect(readdirSync(cwd).length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders the path in bold when stdout is a TTY", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, out } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS, stdoutIsTty: true });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      expect(out.stderrText).toContain("\x1b[1m");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on success", () => {
    const base = tempDir("supabase-report-out-");
    const { layer, telemetry } = setupLegacyReport({ csvs: DEFAULT_RULE_CSVS });
    return Effect.gen(function* () {
      yield* legacyInspectReport(flags({ outputDir: base }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when the command fails", () => {
    const { layer, telemetry } = setupLegacyReport({ resolveFails: true });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacyInspectReport(flags({ outputDir: tempDir("supabase-report-out-") })),
      );
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
