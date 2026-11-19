import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ExperimentalFeature } from "../../shared/config/experimental-feature.ts";

export interface ApiNoun {
  /** Help text of the noun's group. */
  readonly description: string;
  /** Feature that gates every command under the noun. */
  readonly feature: ExperimentalFeature;
  /** Help text of each sub-group, keyed by its dotted path below the noun, e.g. `"tables.layout"`. */
  readonly groups?: Readonly<Record<string, string>>;
}

/** Only these operations generate commands, and their response `links` lead to the reads a `--wait` polls. */
export const generatedOperations: ReadonlyArray<OpenApiOperationId> = [
  "v2-get-warehouse-status",
  "v2-get-warehouse-connection",
  "v2-enable-warehouse",
  "v2-disable-warehouse",
  "v2-get-warehouse-teardown",
  "v2-list-warehouse-tables",
  "v2-get-warehouse-table",
  "v2-get-warehouse-table-layout",
  "v2-update-warehouse-table-layout",
  "v2-get-warehouse-query-stats",
  "v2-get-warehouse-capacity",
];

export const nouns = {
  warehouse: {
    description: "Manage the data warehouse for a project",
    feature: "warehouse",
    groups: {
      inspect: "Inspect Warehouse workload metrics",
      tables: "Inspect tables replicated to Warehouse",
      "tables.layout": "Inspect and update the layout of tables replicated to Warehouse",
      teardowns: "Inspect Warehouse cleanup operations",
    },
  },
} as const satisfies Readonly<Record<string, ApiNoun>>;
