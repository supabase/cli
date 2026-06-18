import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyTelemetryStateTracked } from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import type {
  LegacyInspectConnectionFlags,
  LegacyInspectQuerySpec,
} from "./legacy-inspect-query.ts";
import { legacyDbStatsSpec } from "./db-stats/db-stats.query.ts";
import { legacyIndexStatsSpec } from "./index-stats/index-stats.query.ts";
import { legacyRoleStatsSpec } from "./role-stats/role-stats.query.ts";
import { legacyTableStatsSpec } from "./table-stats/table-stats.query.ts";
import { legacyInspectDbCacheHit } from "./cache-hit/cache-hit.handler.ts";
import { legacyInspectDbIndexSizes } from "./index-sizes/index-sizes.handler.ts";
import { legacyInspectDbIndexUsage } from "./index-usage/index-usage.handler.ts";
import { legacyInspectDbRoleConfigs } from "./role-configs/role-configs.handler.ts";
import { legacyInspectDbRoleConnections } from "./role-connections/role-connections.handler.ts";
import { legacyInspectDbSeqScans } from "./seq-scans/seq-scans.handler.ts";
import { legacyInspectDbTableIndexSizes } from "./table-index-sizes/table-index-sizes.handler.ts";
import { legacyInspectDbTableRecordCounts } from "./table-record-counts/table-record-counts.handler.ts";
import { legacyInspectDbTableSizes } from "./table-sizes/table-sizes.handler.ts";
import { legacyInspectDbTotalIndexSize } from "./total-index-size/total-index-size.handler.ts";
import { legacyInspectDbTotalTableSizes } from "./total-table-sizes/total-table-sizes.handler.ts";
import { legacyInspectDbUnusedIndexes } from "./unused-indexes/unused-indexes.handler.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

function setup() {
  const out = mockOutput({ format: "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  let querySql: string | undefined;
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(LegacyDbConfigResolver, {
      resolve: (_flags: LegacyDbConfigFlags) =>
        Effect.succeed({ conn: LOCAL_CONN, isLocal: true } satisfies LegacyResolvedDbConfig),
      resolvePoolerFallback: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(LegacyDbConnection, {
      connect: () =>
        Effect.succeed({
          exec: () => Effect.void,
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

const flags: LegacyInspectConnectionFlags = {
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
};

// All deprecated-alias handlers share the same factory-produced type.
type AliasHandler = typeof legacyInspectDbCacheHit;

interface AliasCase {
  readonly alias: string;
  readonly handler: AliasHandler;
  readonly routedSpec: LegacyInspectQuerySpec;
  readonly target: string;
}

// One row per deprecated alias: the cobra deprecation target text and the active
// query it actually runs. `table-record-counts` is the Go inconsistency — it warns
// "table-stats" but runs the index-stats query.
const cases: ReadonlyArray<AliasCase> = [
  {
    alias: "cache-hit",
    handler: legacyInspectDbCacheHit,
    routedSpec: legacyDbStatsSpec,
    target: "db-stats",
  },
  {
    alias: "index-usage",
    handler: legacyInspectDbIndexUsage,
    routedSpec: legacyIndexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "total-index-size",
    handler: legacyInspectDbTotalIndexSize,
    routedSpec: legacyIndexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "index-sizes",
    handler: legacyInspectDbIndexSizes,
    routedSpec: legacyIndexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "unused-indexes",
    handler: legacyInspectDbUnusedIndexes,
    routedSpec: legacyIndexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "seq-scans",
    handler: legacyInspectDbSeqScans,
    routedSpec: legacyIndexStatsSpec,
    target: "index-stats",
  },
  {
    alias: "table-record-counts",
    handler: legacyInspectDbTableRecordCounts,
    routedSpec: legacyIndexStatsSpec,
    target: "table-stats",
  },
  {
    alias: "table-sizes",
    handler: legacyInspectDbTableSizes,
    routedSpec: legacyTableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "table-index-sizes",
    handler: legacyInspectDbTableIndexSizes,
    routedSpec: legacyTableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "total-table-sizes",
    handler: legacyInspectDbTotalTableSizes,
    routedSpec: legacyTableStatsSpec,
    target: "table-stats",
  },
  {
    alias: "role-configs",
    handler: legacyInspectDbRoleConfigs,
    routedSpec: legacyRoleStatsSpec,
    target: "role-stats",
  },
  {
    alias: "role-connections",
    handler: legacyInspectDbRoleConnections,
    routedSpec: legacyRoleStatsSpec,
    target: "role-stats",
  },
];

describe("legacy inspect db deprecated aliases", () => {
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
