import { Command } from "effect/unstable/cli";
import { legacyInspectDbBloatCommand } from "./bloat/bloat.command.ts";
import { legacyInspectDbBlockingCommand } from "./blocking/blocking.command.ts";
import { legacyInspectDbCallsCommand } from "./calls/calls.command.ts";
import { legacyInspectDbCacheHitCommand } from "./cache-hit/cache-hit.command.ts";
import { legacyInspectDbDbStatsCommand } from "./db-stats/db-stats.command.ts";
import { legacyInspectDbIndexSizesCommand } from "./index-sizes/index-sizes.command.ts";
import { legacyInspectDbIndexStatsCommand } from "./index-stats/index-stats.command.ts";
import { legacyInspectDbIndexUsageCommand } from "./index-usage/index-usage.command.ts";
import { legacyInspectDbLocksCommand } from "./locks/locks.command.ts";
import { legacyInspectDbLongRunningQueriesCommand } from "./long-running-queries/long-running-queries.command.ts";
import { legacyInspectDbOutliersCommand } from "./outliers/outliers.command.ts";
import { legacyInspectDbReplicationSlotsCommand } from "./replication-slots/replication-slots.command.ts";
import { legacyInspectDbRoleConfigsCommand } from "./role-configs/role-configs.command.ts";
import { legacyInspectDbRoleConnectionsCommand } from "./role-connections/role-connections.command.ts";
import { legacyInspectDbRoleStatsCommand } from "./role-stats/role-stats.command.ts";
import { legacyInspectDbSeqScansCommand } from "./seq-scans/seq-scans.command.ts";
import { legacyInspectDbTableIndexSizesCommand } from "./table-index-sizes/table-index-sizes.command.ts";
import { legacyInspectDbTableRecordCountsCommand } from "./table-record-counts/table-record-counts.command.ts";
import { legacyInspectDbTableSizesCommand } from "./table-sizes/table-sizes.command.ts";
import { legacyInspectDbTableStatsCommand } from "./table-stats/table-stats.command.ts";
import { legacyInspectDbTotalIndexSizeCommand } from "./total-index-size/total-index-size.command.ts";
import { legacyInspectDbTotalTableSizesCommand } from "./total-table-sizes/total-table-sizes.command.ts";
import { legacyInspectDbTrafficProfileCommand } from "./traffic-profile/traffic-profile.command.ts";
import { legacyInspectDbUnusedIndexesCommand } from "./unused-indexes/unused-indexes.command.ts";
import { legacyInspectDbVacuumStatsCommand } from "./vacuum-stats/vacuum-stats.command.ts";

export const legacyInspectDbCommand = Command.make("db").pipe(
  Command.withDescription("Tools to inspect your Supabase database."),
  Command.withShortDescription("Inspect database"),
  Command.withSubcommands([
    legacyInspectDbDbStatsCommand,
    legacyInspectDbReplicationSlotsCommand,
    legacyInspectDbLocksCommand,
    legacyInspectDbBlockingCommand,
    legacyInspectDbOutliersCommand,
    legacyInspectDbCallsCommand,
    legacyInspectDbIndexStatsCommand,
    legacyInspectDbLongRunningQueriesCommand,
    legacyInspectDbBloatCommand,
    legacyInspectDbRoleStatsCommand,
    legacyInspectDbVacuumStatsCommand,
    legacyInspectDbTableStatsCommand,
    legacyInspectDbTrafficProfileCommand,
    legacyInspectDbCacheHitCommand,
    legacyInspectDbIndexUsageCommand,
    legacyInspectDbTotalIndexSizeCommand,
    legacyInspectDbIndexSizesCommand,
    legacyInspectDbTableSizesCommand,
    legacyInspectDbTableIndexSizesCommand,
    legacyInspectDbTotalTableSizesCommand,
    legacyInspectDbUnusedIndexesCommand,
    legacyInspectDbTableRecordCountsCommand,
    legacyInspectDbSeqScansCommand,
    legacyInspectDbRoleConfigsCommand,
    legacyInspectDbRoleConnectionsCommand,
  ]),
);
