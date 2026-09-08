import { Command } from "effect/unstable/cli";
import { inspectDbBloatCommand } from "./bloat/bloat.command.ts";
import { inspectDbBlockingCommand } from "./blocking/blocking.command.ts";
import { inspectDbCallsCommand } from "./calls/calls.command.ts";
import { inspectDbCacheHitCommand } from "./cache-hit/cache-hit.command.ts";
import { inspectDbDbStatsCommand } from "./db-stats/db-stats.command.ts";
import { inspectDbIndexSizesCommand } from "./index-sizes/index-sizes.command.ts";
import { inspectDbIndexStatsCommand } from "./index-stats/index-stats.command.ts";
import { inspectDbIndexUsageCommand } from "./index-usage/index-usage.command.ts";
import { inspectDbLocksCommand } from "./locks/locks.command.ts";
import { inspectDbLongRunningQueriesCommand } from "./long-running-queries/long-running-queries.command.ts";
import { inspectDbOutliersCommand } from "./outliers/outliers.command.ts";
import { inspectDbReplicationSlotsCommand } from "./replication-slots/replication-slots.command.ts";
import { inspectDbRoleConfigsCommand } from "./role-configs/role-configs.command.ts";
import { inspectDbRoleConnectionsCommand } from "./role-connections/role-connections.command.ts";
import { inspectDbRoleStatsCommand } from "./role-stats/role-stats.command.ts";
import { inspectDbSeqScansCommand } from "./seq-scans/seq-scans.command.ts";
import { inspectDbTableIndexSizesCommand } from "./table-index-sizes/table-index-sizes.command.ts";
import { inspectDbTableRecordCountsCommand } from "./table-record-counts/table-record-counts.command.ts";
import { inspectDbTableSizesCommand } from "./table-sizes/table-sizes.command.ts";
import { inspectDbTableStatsCommand } from "./table-stats/table-stats.command.ts";
import { inspectDbTotalIndexSizeCommand } from "./total-index-size/total-index-size.command.ts";
import { inspectDbTotalTableSizesCommand } from "./total-table-sizes/total-table-sizes.command.ts";
import { inspectDbTrafficProfileCommand } from "./traffic-profile/traffic-profile.command.ts";
import { inspectDbToastSizesCommand } from "./toast-sizes/toast-sizes.command.ts";
import { inspectDbUnusedIndexesCommand } from "./unused-indexes/unused-indexes.command.ts";
import { inspectDbVacuumStatsCommand } from "./vacuum-stats/vacuum-stats.command.ts";

export const inspectDbCommand = Command.make("db").pipe(
  Command.withDescription("Tools to inspect your Supabase database."),
  Command.withShortDescription("Inspect database"),
  Command.withSubcommands([
    inspectDbDbStatsCommand,
    inspectDbReplicationSlotsCommand,
    inspectDbLocksCommand,
    inspectDbBlockingCommand,
    inspectDbOutliersCommand,
    inspectDbCallsCommand,
    inspectDbIndexStatsCommand,
    inspectDbLongRunningQueriesCommand,
    inspectDbBloatCommand,
    inspectDbRoleStatsCommand,
    inspectDbVacuumStatsCommand,
    inspectDbTableStatsCommand,
    inspectDbTrafficProfileCommand,
    inspectDbToastSizesCommand,
    inspectDbCacheHitCommand,
    inspectDbIndexUsageCommand,
    inspectDbTotalIndexSizeCommand,
    inspectDbIndexSizesCommand,
    inspectDbTableSizesCommand,
    inspectDbTableIndexSizesCommand,
    inspectDbTotalTableSizesCommand,
    inspectDbUnusedIndexesCommand,
    inspectDbTableRecordCountsCommand,
    inspectDbSeqScansCommand,
    inspectDbRoleConfigsCommand,
    inspectDbRoleConnectionsCommand,
  ]),
);
