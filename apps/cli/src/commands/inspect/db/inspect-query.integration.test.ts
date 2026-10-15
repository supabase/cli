import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
} from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { commandTreeFor } from "../../../../tests/helpers/command-flags.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockTelemetryStateTracked,
  unverifiedTargetBanner,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbConnectError, DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import {
  TargetEmptyValueError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { inspectDbDbStats } from "./db-stats/db-stats.handler.ts";
import { dbStatsSpec } from "./db-stats/db-stats.query.ts";
import { inspectDbLocks } from "./locks/locks.handler.ts";
import { inspectDbRoleStats } from "./role-stats/role-stats.handler.ts";
import { roleStatsSpec } from "./role-stats/role-stats.query.ts";
import type { InspectConnectionFlags } from "./inspect-query.ts";

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
  yes?: boolean;
  /** The ref `SUPABASE_PROJECT_ID` supplies to the real project-ref resolver. */
  projectId?: string;
  /** Raw CLI args slice; drives explicitly-passed flag detection. */
  cliArgs?: ReadonlyArray<string>;
  /** Runs the real `DbConfigResolver` against the temp `workdir`. */
  realLayers?: { readonly workdir: string };
  workdir?: string;
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
  const workdir = opts.realLayers?.workdir ?? opts.workdir ?? "/tmp/inspect-db-test";
  const runtime = buildTestRuntime({
    out,
    api: mockCommandPlatformApi(),
    cliSettings: mockCommandSettings({
      workdir,
      projectId: opts.projectId === undefined ? Option.none() : Option.some(opts.projectId),
    }),
    telemetry: telemetry.layer,
    cliArgs: opts.cliArgs,
  });
  const layer = Layer.mergeAll(
    runtime,
    opts.realLayers === undefined
      ? resolver.layer
      : realDbConfigResolver({
          workdir: opts.realLayers.workdir,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        }),
    connection.layer,
    Layer.succeed(DnsResolverFlag, opts.dnsResolver ?? "native"),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord(
        opts.realLayers === undefined ? {} : { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        { preserveEmptyStrings: true },
      ),
    ),
    configValuesLayer(),
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
  const workdir = useTempWorkdir("supabase-inspect-db-runner-");

  it.effect("renders a glamour table in text mode (db-stats)", () => {
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

  it.effect("collapses statement whitespace and formats bool/int cells (locks)", () => {
    const { layer, out } = setup({ rows: [LOCKS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbLocks(flags());
      expect(out.stdoutText).toContain("SELECT * FROM users");
      expect(out.stdoutText).toContain("true");
      expect(out.stdoutText).toContain("1234");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders an empty backtick-wrapped cell as two literal backticks (role-stats)", () => {
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

  it.effect("emits raw rows in json mode", () => {
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

  it.effect("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json", rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "inspect db db-stats" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("inspects an explicit database url", () => {
    const { layer, resolver, connection, out } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      rows: [DB_STATS_ROW],
    });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ dbUrl: Option.some("postgres://x") }));
      const target = resolver.connectionInput?.target;
      expect(target?.kind).toBe("db-url");
      expect(target?.kind === "db-url" ? Redacted.value(target.url) : undefined).toBe(
        "postgres://x",
      );
      expect(connection.connectCalls[0]?.isLocal).toBe(false);
      expect(out.stderrText).not.toContain("Connecting to");
    }).pipe(Effect.provide(layer));
  });

  it.effect("inspects the local database with --local", () => {
    const { layer, resolver, out } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ local: true }));
      expect(resolver.connectionInput?.target).toEqual({ kind: "local" });
      expect(out.stderrText).not.toContain("Connecting to");
    }).pipe(Effect.provide(layer));
  });

  it.effect("inspects the local database when no selector is given", () => {
    const { layer, resolver, out } = setup({ rows: [DB_STATS_ROW], projectId: VALID_REF });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(resolver.connectionInput?.target).toEqual({ kind: "local" });
      expect(out.stderrText).not.toContain("Target:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows a workspace target of remote to the linked project", () => {
    const { layer, resolver, out } = setup({
      rows: [DB_STATS_ROW],
      workdir: workdir.current,
      projectId: VALID_REF,
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir.current, "supabase", "config.toml"),
        'target = "remote"\n',
      );
      yield* inspectDbDbStats(flags());
      expect(resolver.connectionInput?.target).toMatchObject({ kind: "linked", ref: VALID_REF });
      expect(out.stderrText).toContain(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("--linked routes to the linked project and announces it", () => {
    const { layer, resolver, out } = setup({ rows: [DB_STATS_ROW], projectId: VALID_REF });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ linked: true }));
      expect(resolver.connectionInput?.target).toMatchObject({ kind: "linked", ref: VALID_REF });
      expect(out.stderrText).toContain(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("--project-ref implies the linked project", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver, out } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ projectRef: Option.some(FLAG_REF) }));
      expect(resolver.connectionInput?.target).toMatchObject({
        kind: "linked",
        ref: FLAG_REF,
        source: "flag",
      });
      expect(out.stderrText).toContain(unverifiedTargetBanner(FLAG_REF));
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects conflicting target flags", () => {
    const { layer, resolver } = setup();
    return Effect.gen(function* () {
      const error = yield* inspectDbDbStats(flags({ linked: true, local: true })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
      expect(resolver.connectionInput).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --project-ref combined with --local", () => {
    const { layer, resolver } = setup();
    return Effect.gen(function* () {
      const error = yield* inspectDbDbStats(
        flags({ local: true, projectRef: Option.some("flagflagflagflagflag") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetProjectRefConflictError);
      expect(resolver.connectionInput).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes network-ban removal only under --yes", () => {
    const withoutYes = setup({ rows: [DB_STATS_ROW] });
    const withYes = setup({ rows: [DB_STATS_ROW], yes: true });
    const banRemoval = (input: DbConnectionInput | undefined) =>
      input === undefined ? undefined : Option.isSome(input.networkBanRemoval);
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags({ local: true })).pipe(Effect.provide(withoutYes.layer));
      yield* inspectDbDbStats(flags({ local: true })).pipe(Effect.provide(withYes.layer));
      expect(banRemoval(withoutYes.resolver.connectionInput)).toBe(false);
      expect(banRemoval(withYes.resolver.connectionInput)).toBe(true);
    });
  });

  it.effect("surfaces a query failure", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("syntax error");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a connection failure", () => {
    const { layer } = setup({ connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a resolution failure", () => {
    const { layer } = setup({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbDbStats(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("cannot load config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders the header and separator for an empty result set", () => {
    const { layer, out } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      const expected = renderGlamourTable(dbStatsSpec.headers, []);
      expect(out.stdoutText).toBe(expected);
      expect(out.stdoutText).toContain("Database Size");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits an empty rows array in json mode for no results", () => {
    const { layer, out } = setup({ format: "json", rows: [] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", data: { rows: [] } }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards the https dns resolver to the connection", () => {
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

  it.effect("flushes telemetry on completion", () => {
    const { layer, telemetry } = setup({ rows: [DB_STATS_ROW] });
    return Effect.gen(function* () {
      yield* inspectDbDbStats(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry even when the query fails", () => {
    const { layer, telemetry } = setup({ queryFails: true });
    return Effect.gen(function* () {
      yield* Effect.exit(inspectDbDbStats(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("inspect db through the real database-config resolver", () => {
  const tempRoot = useTempWorkdir("supabase-inspect-db-int-");
  const poolerRequest = `GET /v1/projects/${VALID_REF}/config/database/pooler`;
  const loginRoleRequest = `POST /v1/projects/${VALID_REF}/cli/login-role`;
  const asLines = (requests: ReadonlyArray<StubbedRequest>) =>
    requests.map(({ method, path }) => `${method} ${path}`);

  const INSPECT_DB_LEAVES = [...commandTreeFor(undefined)]
    .filter(([path, node]) => node.isLeaf && path.startsWith("inspect db "))
    .map(([path]) => path);
  // Removed commands fail before any Management API call, so they never reach the shared runner.
  const REMOVED_INSPECT_DB_LEAVES = [
    "inspect db table-index-sizes",
    "inspect db total-index-size",
    "inspect db total-table-sizes",
  ];
  const RUNNER_INSPECT_DB_LEAVES = INSPECT_DB_LEAVES.filter(
    (command) => !REMOVED_INSPECT_DB_LEAVES.includes(command),
  );

  it.effect(
    "every inspect db subcommand declares the calls the shared runner makes on the linked project",
    () => {
      const { layer, out, connection } = setup({
        rows: [DB_STATS_ROW],
        cliArgs: ["inspect", "db", "db-stats", "--project-ref", VALID_REF],
        realLayers: { workdir: tempRoot.current },
      });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* inspectDbDbStats(flags({ projectRef: Option.some(VALID_REF) }));
        expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
        expect(connection.connectCalls[0]?.cfg.host).toBe("aws-0-us-east-1.pooler.supabase.com");
        expect(out.stdoutText).toContain("8192 kB");
        expect(INSPECT_DB_LEAVES).toHaveLength(25);
        expect(INSPECT_DB_LEAVES).toEqual(expect.arrayContaining(REMOVED_INSPECT_DB_LEAVES));
        for (const command of RUNNER_INSPECT_DB_LEAVES) {
          assertPermissionDrift({
            command,
            activeFlags: { "project-ref": VALID_REF },
            requests: asRecordedRequests(requests),
            exact: true,
          });
        }
        for (const command of REMOVED_INSPECT_DB_LEAVES) {
          assertPermissionDrift({
            command,
            activeFlags: { "project-ref": VALID_REF },
            requests: [],
            exact: true,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("--linked=false still reaches the linked project through the real resolver", () => {
    const { layer } = setup({
      rows: [DB_STATS_ROW],
      cliArgs: ["inspect", "db", "db-stats", "--linked=false", "--project-ref", VALID_REF],
      realLayers: { workdir: tempRoot.current },
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* inspectDbDbStats(flags({ projectRef: Option.some(VALID_REF) }));
      expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
      assertPermissionDrift({
        command: "inspect db db-stats",
        activeFlags: { linked: false, "project-ref": VALID_REF },
        requests: asRecordedRequests(requests),
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("rejects an empty --project-ref before any Management API request", () => {
    const { layer } = setup({
      rows: [DB_STATS_ROW],
      cliArgs: ["inspect", "db", "db-stats", "--project-ref", ""],
      realLayers: { workdir: tempRoot.current },
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      const error = yield* inspectDbDbStats(flags({ projectRef: Option.some("") })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(TargetEmptyValueError);
      expect(requests).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --local", () => {
    const { layer, connection } = setup({
      rows: [DB_STATS_ROW],
      cliArgs: ["inspect", "db", "db-stats", "--local"],
      realLayers: { workdir: tempRoot.current },
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* inspectDbDbStats(flags({ local: true }));
      expect(connection.connectCalls).toHaveLength(1);
      expect(requests).toEqual([]);
      assertPermissionDrift({
        command: "inspect db db-stats",
        activeFlags: { local: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --db-url", () => {
    const DB_URL = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, connection } = setup({
      rows: [DB_STATS_ROW],
      cliArgs: ["inspect", "db", "db-stats", "--db-url", DB_URL],
      realLayers: { workdir: tempRoot.current },
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* inspectDbDbStats(flags({ dbUrl: Option.some(DB_URL) }));
      expect(connection.connectCalls).toHaveLength(1);
      expect(requests).toEqual([]);
      assertPermissionDrift({
        command: "inspect db db-stats",
        activeFlags: { "db-url": true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});
