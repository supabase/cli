import type { ApiCommandEntry } from "./api-command.model.ts";
import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ExperimentalFeature } from "../../shared/config/experimental-feature.ts";

export interface ApiNoun {
  /** Help text of the noun's group. */
  readonly description: string;
  /** Experimental flag (`experimental.<name>`) that gates every command under the noun. */
  readonly experimental: ExperimentalFeature;
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
  "v2-add-warehouse-replication",
  "v2-remove-warehouse-replication",
  "v2-resync-warehouse-replication",
  "v2-restart-warehouse-replication",
];

export interface ApiCommandPolicy {
  readonly confirmDescription?: true;
  readonly examples?: ApiCommandEntry["examples"];
}

/** CLI presentation choices, independent of the API's operation metadata. */
export const commandPolicies = {
  "v2-disable-warehouse": { confirmDescription: true },
  "v2-update-warehouse-table-layout": {
    confirmDescription: true,
    examples: [
      {
        command: `supabase warehouse tables layout update <table-id> --partition-by '[{"column":"event_at","transform":{"kind":"day"}}]' --sort-by '{"kind":"columns","columns":[{"name":"tenant_id","direction":"asc"},{"name":"event_at","direction":"desc","nulls":"last"}]}'`,
        description:
          "Partition new files by event day and sort within files; preserve historical files.",
      },
      {
        command: `supabase warehouse tables layout update <table-id> --partition-by '[{"column":"tenant_id","transform":{"kind":"bucket","count":8}}]' --dry-run`,
        description: "Preview eight hash buckets locally without changing the Warehouse.",
      },
      {
        command: `supabase warehouse tables layout update <table-id> --partition-by '[]' --sort-by '{"kind":"none"}'`,
        description: "Clear partitioning and sorting for future writes.",
      },
      {
        command: `supabase warehouse tables layout update <table-id> --partition-by 'null' --sort-by 'null'`,
        description: "Stop managing both settings; omitted flags preserve their saved values.",
      },
    ],
  },
  "v2-add-warehouse-replication": { confirmDescription: true },
  "v2-remove-warehouse-replication": { confirmDescription: true },
  "v2-resync-warehouse-replication": { confirmDescription: true },
  "v2-restart-warehouse-replication": { confirmDescription: true },
} satisfies Partial<Record<OpenApiOperationId, ApiCommandPolicy>>;

export const nouns = {
  warehouse: {
    description: "Manage the data warehouse for a project",
    experimental: "warehouse",
    groups: {
      replication: "Manage Warehouse replication selections and rebuilds",
      inspect: "Inspect Warehouse workload metrics",
      tables: "Inspect tables replicated to Warehouse",
      "tables.layout": "Inspect and update the layout of tables replicated to Warehouse",
      teardowns: "Inspect Warehouse cleanup operations",
    },
  },
} as const satisfies Readonly<Record<string, ApiNoun>>;
