import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { mockTelemetryStateTracked } from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnectError, DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { inspectDbDbStats } from "./db-stats/db-stats.handler.ts";
import { dbStatsSpec } from "./db-stats/db-stats.query.ts";
import { inspectDbLocks } from "./locks/locks.handler.ts";
import { inspectDbRoleStats } from "./role-stats/role-stats.handler.ts";
import { roleStatsSpec } from "./role-stats/role-stats.query.ts";
import {
  InspectMutuallyExclusiveFlagsError,
  type InspectConnectionFlags,
} from "./inspect-query.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};
const REMOTE_CONN: PgConnInput = {
  host: "db.abcdefghijklmnopqrst.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

const DB_STATS_ROW = {
  database_size: "8192 kB",
  total_index_size: "1024 kB",
  total_table_size: "2048 kB",
  total_toast_size: "0 bytes",
  time_since_stats_reset: "01:23:45",
  index_hit_rate: "0.99",
  table_hit_rate: "0.95",
  wal_size: "16 MB",
};

const LOCKS_ROW = {
  pid: 1234,
  relname: "public.users",
  transactionid: "null",
  granted: true,
  stmt: "SELECT *\n  FROM\tusers",
  age: "00:05:00",
};

function mockResolver(opts: { conn?: PgConnInput; isLocal?: boolean; fails?: boolean }) {
  let resolveInput: DbConfigFlags | undefined;
  const layer = Layer.succeed(DbConfigResolver, {
    resolve: (flags: DbConfigFlags) => {
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

function mockDbConnection(opts: {
  rows?: ReadonlyArray<Record<string, unknown>>;
  connectFails?: boolean;
  queryFails?: boolean;
}) {
  const connectCalls: Array<{
    cfg: PgConnInput;
    isLocal: boolean;
    dnsResolver: "native" | "https";
  }> = [];
  let querySql: string | undefined;
  let queryParams: ReadonlyArray<unknown> | undefined;
  const layer = Layer.succeed(DbConnection, {
    connect: (cfg, options) => {
      connectCalls.push({ cfg, isLocal: options.isLocal, dnsResolver: options.dnsResolver });
      if (opts.connectFails === true) {
        return Effect.fail(
          new DbConnectError({ message: "failed to connect to postgres: refused" }),
        );
      }
      return Effect.succeed({
        exec: () => Effect.void,
        execBatch: () => Effect.void,
        extensionExists: () => Effect.succeed(false),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        query: (sql: string, params?: ReadonlyArray<unknown>) => {
          querySql = sql;
          queryParams = params;
          if (opts.queryFails === true) {
            return Effect.fail(new DbExecError({ message: "syntax error" }));
          }
          return Effect.succeed(opts.rows ?? []);
        },
      });
    },
  });
  return {
    layer,
    get connectCalls() {
      return connectCalls;
    },
    get querySql() {
      return querySql;
    },
    get queryParams() {
      return queryParams;
    },
  };
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  conn?: PgConnInput;
  isLocal?: boolean;
  rows?: ReadonlyArray<Record<string, unknown>>;
  resolveFails?: boolean;
  connectFails?: boolean;
  queryFails?: boolean;
  dnsResolver?: "native" | "https";
  /** Raw CLI args slice; drives explicitly-passed flag detection. */
  cliArgs?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({
    conn: opts.conn,
    isLocal: opts.isLocal,
    fails: opts.resolveFails,
  });
  const connection = mockDbConnection({
    rows: opts.rows,
    connectFails: opts.connectFails,
    queryFails: opts.queryFails,
  });
  const telemetry = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    telemetry.layer,
    Layer.succeed(DnsResolverFlag, opts.dnsResolver ?? "native"),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
  );
  return { layer, out, resolver, connection, telemetry };
}

const flags = (over: Partial<InspectConnectionFlags> = {}): InspectConnectionFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none<string>(),
});

describe("inspect db query runner", () => {
  it.live("renders a glamour table in text mode (db-stats)", () => {
    const { layer, out, connection } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(connection.querySql).toBe(dbStatsSpec.sql);
      expect(connection.queryParams?.[1]).toBe("postgres");
      expect(Array.isArray(connection.queryParams?.[0])).toBe(true);
      const expected = renderGlamourTable(dbStatsSpec.headers, [
        dbStatsSpec.project(DB_STATS_ROW, { conn: LOCAL_CONN, isLocal: true }),
      ]);
      expect(out.stdoutText).toBe(expected);
      expect(out.stdoutText).toContain("postgres");
      expect(out.stdoutText).toContain("8192 kB");
      expect(out.stdoutText).toContain("WAL Size");
    }).pipe(Effect.provide(layer));
  });

  it.live("collapses statement whitespace and formats bool/int cells (locks)", () => {
    const { layer, out } = setup({ rows: [LOCKS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbLocks(flags());
      expect(out.stdoutText).toContain("SELECT * FROM users");
      expect(out.stdoutText).toContain("true");
      expect(out.stdoutText).toContain("1234");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders an empty backtick-wrapped cell as two literal backticks (role-stats)", () => {
    const ROLE_ROW = {
      role_name: "postgres",
      active_connections: 3,
      connection_limit: 100,
      custom_config: null,
    };
    const { layer, out } = setup({ rows: [ROLE_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbRoleStats(flags());
      const cells = roleStatsSpec.project(ROLE_ROW, { conn: LOCAL_CONN, isLocal: true });
      expect(cells[3]).toBe("``");
      const expected = renderGlamourTable(roleStatsSpec.headers, [cells]);
      expect(out.stdoutText).toBe(expected);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits raw rows in json mode", () => {
    const { layer, out } = setup({ format: "json", rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "inspect db db-stats",
          data: { rows: [DB_STATS_ROW] },
        }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json", rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "inspect db db-stats" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects an explicit database url", () => {
    const { layer, resolver, connection } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      rows: [DB_STATS_ROW],
      cliArgs: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ dbUrl: Option.some("postgres://x") }));
      expect(Option.isSome(resolver.resolveInput?.dbUrl ?? Option.none())).toBe(true);
      expect(resolver.resolveInput?.connType).toBe("db-url");
      expect(connection.connectCalls[0]?.isLocal).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects the local database", () => {
    const { layer, resolver, out } = setup({ rows: [DB_STATS_ROW], cliArgs: ["--local"] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ local: true }));
      expect(resolver.resolveInput?.connType).toBe("local");
      expect(out.stderrText).toContain("Connecting to local database...");
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects the linked project by default (no connection flag)", () => {
    const { layer, resolver } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(resolver.resolveInput?.connType).toBe("linked");
      expect(Option.isNone(resolver.resolveInput?.dbUrl ?? Option.some("x"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("labels the diagnostic 'remote' for a non-local connection", () => {
    const { layer, out } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      rows: [DB_STATS_ROW],
      cliArgs: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ dbUrl: Option.some("postgres://x") }));
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects conflicting connection flags", () => {
    const { layer } = setup({ cliArgs: ["--linked", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags({ linked: true, local: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          const error = failure.value;
          expect(error).toBeInstanceOf(InspectMutuallyExclusiveFlagsError);
          if (error instanceof InspectMutuallyExclusiveFlagsError) {
            expect(error.message).toBe(
              "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
            );
          }
        }
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false is Changed and routes to local (not linked)", () => {
    const { layer, resolver } = setup({ rows: [DB_STATS_ROW], cliArgs: ["--local=false"] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ local: false }));
      expect(resolver.resolveInput?.connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked --local=false raises the mutual-exclusion error", () => {
    const { layer } = setup({ cliArgs: ["--linked", "--local=false"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags({ linked: true, local: false })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          const error = failure.value;
          expect(error).toBeInstanceOf(InspectMutuallyExclusiveFlagsError);
          if (error instanceof InspectMutuallyExclusiveFlagsError) {
            expect(error.message).toBe(
              "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
            );
          }
        }
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked routes to linked", () => {
    const { layer, resolver } = setup({ rows: [DB_STATS_ROW], cliArgs: ["--linked"] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ linked: true }));
      expect(resolver.resolveInput?.connType).toBe("linked");
    }).pipe(Effect.provide(layer));
  });

  it.live("inspects the project given via --project-ref on the default linked path", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ projectRef: Option.some(FLAG_REF) }));
      expect(resolver.resolveInput?.connType).toBe("linked");
      expect(resolver.resolveInput?.linkedProjectRef).toEqual(Option.some(FLAG_REF));
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver } = setup({ rows: [DB_STATS_ROW], cliArgs: ["--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        inspectDbDbStats(flags({ local: true, projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          const error = failure.value;
          expect(error).toBeInstanceOf(InspectMutuallyExclusiveFlagsError);
          if (error instanceof InspectMutuallyExclusiveFlagsError) {
            expect(error.message).toBe(
              "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
            );
          }
        }
      }
      expect(resolver.resolveInput).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a query failure", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("syntax error");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a connection failure", () => {
    const { layer } = setup({ connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a resolution failure", () => {
    const { layer } = setup({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("cannot load config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("renders the header and separator for an empty result set", () => {
    const { layer, out } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      const expected = renderGlamourTable(dbStatsSpec.headers, []);
      expect(out.stdoutText).toBe(expected);
      expect(out.stdoutText).toContain("Database Size");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits an empty rows array in json mode for no results", () => {
    const { layer, out } = setup({ format: "json", rows: [] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", data: { rows: [] } }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards the https dns resolver to the connection", () => {
    const { layer, connection } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      rows: [DB_STATS_ROW],
      dnsResolver: "https",
    });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ dbUrl: Option.some("postgres://x") }));
      expect(connection.connectCalls[0]?.dnsResolver).toBe("https");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on completion", () => {
    const { layer, telemetry } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when the query fails", () => {
    const { layer, telemetry } = setup({ queryFails: true });
    return Effect.gen(function* () {
      yield* Effect.exit(inspectDbDbStats(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
