import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { bloatSpec } from "./bloat/bloat.query.ts";
import { blockingSpec } from "./blocking/blocking.query.ts";
import { callsSpec } from "./calls/calls.query.ts";
import { dbStatsSpec } from "./db-stats/db-stats.query.ts";
import { indexStatsSpec } from "./index-stats/index-stats.query.ts";
import { INTERNAL_SCHEMAS } from "./inspect-schemas.ts";
import { runInspectQuery, type InspectQuerySpec } from "./inspect-query.ts";
import { locksSpec } from "./locks/locks.query.ts";
import { longRunningQueriesSpec } from "./long-running-queries/long-running-queries.query.ts";
import { outliersSpec } from "./outliers/outliers.query.ts";
import { replicationSlotsSpec } from "./replication-slots/replication-slots.query.ts";
import { roleStatsSpec } from "./role-stats/role-stats.query.ts";
import { tableStatsSpec } from "./table-stats/table-stats.query.ts";
import { trafficProfileSpec } from "./traffic-profile/traffic-profile.query.ts";
import { vacuumStatsSpec } from "./vacuum-stats/vacuum-stats.query.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

function setup(rows: ReadonlyArray<Record<string, unknown>>) {
  const out = mockOutput({ format: "text" });
  let querySql: string | undefined;
  let queryParams: ReadonlyArray<unknown> | undefined;
  const layer = Layer.mergeAll(
    out.layer,
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DbConfigResolver, {
      resolve: (_flags: DbConfigFlags) =>
        Effect.succeed({ conn: LOCAL_CONN, isLocal: true } satisfies ResolvedDbConfig),
      resolvePoolerFallback: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(DbConnection, {
      connect: () =>
        Effect.succeed({
          exec: () => Effect.void,
          execBatch: () => Effect.void,
          extensionExists: () => Effect.succeed(false),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          query: (sql: string, params?: ReadonlyArray<unknown>) => {
            querySql = sql;
            queryParams = params;
            return Effect.succeed(rows);
          },
        }),
    }),
  );
  return {
    layer,
    out,
    get querySql() {
      return querySql;
    },
    get queryParams() {
      return queryParams;
    },
  };
}

const localFlags = {
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
  projectRef: Option.none<string>(),
};

type ParamKind = "none" | "schemas1" | "schemas2";

interface Case {
  readonly spec: InspectQuerySpec;
  readonly row: Record<string, unknown>;
  readonly params: ParamKind;
  readonly expect: ReadonlyArray<string>;
  readonly absent?: ReadonlyArray<string>;
}

const cases: ReadonlyArray<Case> = [
  {
    spec: dbStatsSpec,
    params: "schemas2",
    row: {
      database_size: "8 kB",
      total_index_size: "1 kB",
      total_table_size: "2 kB",
      total_toast_size: "0 bytes",
      time_since_stats_reset: "N/A",
      index_hit_rate: "0.9",
      table_hit_rate: "0.8",
      wal_size: "16 MB",
    },
    expect: ["postgres", "8 kB", "16 MB", "Database Size"],
  },
  {
    spec: replicationSlotsSpec,
    params: "none",
    row: {
      slot_name: "slot1",
      active: true,
      state: "streaming",
      replication_client_address: "10.0.0.1",
      replication_lag_gb: "0",
    },
    expect: ["slot1", "true", "streaming", "10.0.0.1"],
  },
  {
    spec: locksSpec,
    params: "none",
    row: {
      pid: 42,
      relname: "public.t",
      transactionid: "100",
      granted: false,
      stmt: "SELECT\n1",
      age: "00:01",
    },
    expect: ["42", "public.t", "false", "SELECT 1"],
  },
  {
    spec: blockingSpec,
    params: "none",
    row: {
      blocked_pid: 1,
      blocking_statement: "UPDATE\tx",
      blocking_duration: "00:02",
      blocking_pid: 2,
      blocked_statement: "SELECT y",
      blocked_duration: "00:03",
    },
    expect: ["UPDATE x", "SELECT y", "00:02"],
  },
  {
    spec: outliersSpec,
    params: "none",
    row: {
      query: "SELECT\n  *",
      total_exec_time: "10ms",
      prop_exec_time: "50%",
      ncalls: "5",
      sync_io_time: "1ms",
    },
    expect: ["SELECT *", "10ms", "50%"],
  },
  {
    spec: callsSpec,
    params: "none",
    row: {
      query: "INSERT\tINTO t",
      total_exec_time: "20ms",
      prop_exec_time: "25%",
      ncalls: "9",
      sync_io_time: "2ms",
    },
    expect: ["INSERT INTO t", "20ms", "25%"],
  },
  {
    spec: indexStatsSpec,
    params: "schemas1",
    row: {
      name: "public.idx",
      size: "8 kB",
      percent_used: "50%",
      index_scans: "100",
      seq_scans: "5",
      unused: false,
    },
    expect: ["public.idx", "8 kB", "50%", "100", "false"],
  },
  {
    spec: longRunningQueriesSpec,
    params: "none",
    row: { pid: 7, duration: "00:06", query: "SELECT pg_sleep(600)" },
    expect: ["7", "00:06", "SELECT pg_sleep(600)"],
  },
  {
    spec: bloatSpec,
    params: "schemas1",
    row: { type: "table", name: "public.t", bloat: "1.5", waste: "100 kB" },
    expect: ["table", "public.t", "1.5", "100 kB"],
  },
  {
    spec: roleStatsSpec,
    params: "none",
    row: {
      role_name: "postgres",
      active_connections: 3,
      connection_limit: 100,
      custom_config: "search_path=public",
    },
    expect: ["postgres", "3", "100", "search_path=public"],
  },
  {
    spec: vacuumStatsSpec,
    params: "schemas1",
    row: {
      name: "public.t",
      last_vacuum: "2024-01-01 00:00",
      last_autovacuum: "",
      last_analyze: "",
      last_autoanalyze: "",
      // Padded as Postgres `to_char(reltuples, '9G999G999G999')` returns it for -1.
      rowcount: "           -1",
      dead_rowcount: "0",
      autovacuum_threshold: "777",
      expect_autovacuum: "no",
      autoanalyze_threshold: "888",
      expect_autoanalyze: "no",
    },
    expect: ["public.t", "No stats", "2024-01-01 00:00"],
    // The two threshold columns are dropped (only 9 of 11 columns are rendered).
    absent: ["777", "888"],
  },
  {
    spec: tableStatsSpec,
    params: "schemas1",
    row: {
      name: "public.t",
      table_size: "8 kB",
      index_size: "2 kB",
      total_size: "10 kB",
      estimated_row_count: 1000,
      seq_scans: 5,
    },
    expect: ["public.t", "8 kB", "10 kB", "1000"],
  },
  {
    spec: trafficProfileSpec,
    params: "none",
    row: {
      schemaname: "public",
      table_name: "t",
      blocks_read: 100,
      write_tuples: 50,
      blocks_write: 12,
      activity_ratio: "1:1 (Balanced)",
    },
    expect: ["public", "100", "50", "12.0", "1:1 (Balanced)"],
  },
];

describe("inspect db specs (per-subcommand correctness)", () => {
  it("covers all 13 active subcommands", () => {
    expect(cases).toHaveLength(13);
  });

  for (const testCase of cases) {
    it.live(`runs the ${testCase.spec.name} query and renders its cells`, () => {
      const ctx = setup([testCase.row]);
      return Effect.gen(function* () {
        yield* runInspectQuery(testCase.spec, localFlags, "native");

        expect(ctx.querySql).toBe(testCase.spec.sql);

        if (testCase.params === "none") {
          expect(ctx.queryParams).toEqual([]);
        } else {
          const params = ctx.queryParams ?? [];
          expect(params[0]).toHaveLength(INTERNAL_SCHEMAS.length);
          if (testCase.params === "schemas2") {
            expect(params).toHaveLength(2);
            expect(params[1]).toBe("postgres");
          } else {
            expect(params).toHaveLength(1);
          }
        }

        for (const header of testCase.spec.headers) {
          expect(ctx.out.stdoutText).toContain(header);
        }
        for (const cell of testCase.expect) {
          expect(ctx.out.stdoutText).toContain(cell);
        }
        for (const missing of testCase.absent ?? []) {
          expect(ctx.out.stdoutText).not.toContain(missing);
        }
      }).pipe(Effect.provide(ctx.layer));
    });
  }

  it("projects a null blocking_statement to the two-backtick empty code span, keeping blocked_statement bare", () => {
    const row: Record<string, unknown> = {
      blocked_pid: 1,
      blocking_statement: null,
      blocking_duration: "00:02",
      blocking_pid: 2,
      blocked_statement: "",
      blocked_duration: "00:03",
    };
    const cells = blockingSpec.project(row, {
      conn: LOCAL_CONN,
      isLocal: true,
    } satisfies ResolvedDbConfig);
    expect(cells[1]).toBe("``");
    expect(cells[4]).toBe("");
  });
});
