import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ApiCommandWait } from "./api-command.model.ts";

/** Verbs every generated command may use. */
export const verbVocabulary = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
  "status",
  "add",
  "remove",
  "resync",
] as const;

export interface ApiNoun {
  readonly description: string;
  /** Feature that gates every command under the noun. */
  readonly feature: string;
  /** Help text of each sub-group, keyed by its dotted path below the noun, e.g. `"tables.layout"`. */
  readonly groups?: Readonly<Record<string, string>>;
}

/** How to tell that the resource a read operation returns has settled. */
export type ApiCommandPoll = Pick<ApiCommandWait, "status" | "succeeded" | "failed" | "error">;

/** Only these operations generate commands; `x-operation` on any other operation is ignored. */
export const generatedOperations: ReadonlyArray<OpenApiOperationId> = [
  "v2-get-warehouse-status",
  "v2-enable-warehouse",
  "v2-disable-warehouse",
  "v2-get-warehouse-teardown",
];

export const nouns = {
  warehouse: {
    description: "Manage the data warehouse for a project",
    feature: "warehouse",
    groups: {
      teardowns: "Inspect Warehouse cleanup operations",
      replication: "Manage Warehouse replication targets and resynchronization",
      tables: "Inspect replicated Warehouse tables",
      "tables.layout": "Inspect and configure Warehouse table layout",
    },
  },
} as const satisfies Readonly<Record<string, ApiNoun>>;
