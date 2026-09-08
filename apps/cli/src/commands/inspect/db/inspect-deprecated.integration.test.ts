import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { mockTelemetryStateTracked } from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import type { InspectConnectionFlags, InspectQuerySpec } from "./inspect-query.ts";
import { dbStatsSpec } from "./db-stats/db-stats.query.ts";
import { indexStatsSpec } from "./index-stats/index-stats.query.ts";
import { roleStatsSpec } from "./role-stats/role-stats.query.ts";
import { tableStatsSpec } from "./table-stats/table-stats.query.ts";
import { inspectDbCacheHit } from "./cache-hit/cache-hit.handler.ts";
import { inspectDbIndexSizes } from "./index-sizes/index-sizes.handler.ts";
import { inspectDbIndexUsage } from "./index-usage/index-usage.handler.ts";
import { inspectDbRoleConfigs } from "./role-configs/role-configs.handler.ts";
import { inspectDbRoleConnections } from "./role-connections/role-connections.handler.ts";
import { inspectDbSeqScans } from "./seq-scans/seq-scans.handler.ts";
import { inspectDbTableIndexSizes } from "./table-index-sizes/table-index-sizes.handler.ts";
import { inspectDbTableRecordCounts } from "./table-record-counts/table-record-counts.handler.ts";
import { inspectDbTableSizes } from "./table-sizes/table-sizes.handler.ts";
import { inspectDbTotalIndexSize } from "./total-index-size/total-index-size.handler.ts";
import { inspectDbTotalTableSizes } from "./total-table-sizes/total-table-sizes.handler.ts";
import { inspectDbUnusedIndexes } from "./unused-indexes/unused-indexes.handler.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

function setup() {
  const out = mockOutput({ format: "text" });
  const telemetry = mockTelemetryStateTracked();
  let querySql: string | undefined;
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    Layer.succeed(DnsResolverFlag, "native"),
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
          query: (sql: string) => {
            querySql = sql;
            return Effect.succeed([]);
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
  };
}

const flags: InspectConnectionFlags = {
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
  projectRef: Option.none<string>(),
};

// All deprecated-alias handlers share the same factory-produced type.
type AliasHandler = typeof inspectDbCacheHit;

interface AliasCase {
  readonly alias: string;
  readonly handler: AliasHandler;
  readonly routedSpec: InspectQuerySpec;
  readonly target: string;
}

// One row per deprecated alias: the deprecation target text and the active
// query it actually runs. `table-record-counts` is the established inconsistency —
// it warns "table-stats" but runs the index-stats query.
const cases: ReadonlyArray<AliasCase> = [
  {
    alias: "cache-hit",
    handler: inspectDbCacheHit,
    routedSpec: dbStatsSpec,
    target: "db-stats",
  },
  {
    alias: "index-usage",
    handler: inspectDbIndexUsage,
    routedSpec: indexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "total-index-size",
    handler: inspectDbTotalIndexSize,
    routedSpec: indexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "index-sizes",
    handler: inspectDbIndexSizes,
    routedSpec: indexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "unused-indexes",
    handler: inspectDbUnusedIndexes,
    routedSpec: indexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "seq-scans",
    handler: inspectDbSeqScans,
    routedSpec: indexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "table-record-counts",
    handler: inspectDbTableRecordCounts,
    routedSpec: indexStatsSpec,
    target: "table-stats",
  },
  {
    alias: "table-sizes",
    handler: inspectDbTableSizes,
    routedSpec: tableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "table-index-sizes",
    handler: inspectDbTableIndexSizes,
    routedSpec: tableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "total-table-sizes",
    handler: inspectDbTotalTableSizes,
    routedSpec: tableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "role-configs",
    handler: inspectDbRoleConfigs,
    routedSpec: roleStatsSpec,
    target: "role-stats",
  },
  {
    alias: "role-connections",
    handler: inspectDbRoleConnections,
    routedSpec: roleStatsSpec,
    target: "role-stats",
  },
];

describe("inspect db deprecated aliases", () => {
  it("covers all 12 deprecated aliases", () => {
    expect(cases).toHaveLength(12);
  });

  for (const testCase of cases) {
    it.live(`${testCase.alias} warns and runs the ${testCase.routedSpec.name} query`, () => {
      const ctx = setup();
      return Effect.gen(function* () {
        yield* testCase.handler(flags);
        expect(ctx.out.stderrText).toContain(
          `Command "${testCase.alias}" is deprecated, use "${testCase.target}" instead.`,
        );
        expect(ctx.querySql).toBe(testCase.routedSpec.sql);
      }).pipe(Effect.provide(ctx.layer));
    });
  }
});
