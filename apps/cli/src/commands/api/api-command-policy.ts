import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ExperimentalFeature } from "../../shared/config/experimental-feature.ts";
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
  "connection",
  "add",
  "remove",
  "resync",
] as const;

export interface ApiNoun {
  readonly description: string;
  /** Feature that gates every command under the noun. */
  readonly feature: ExperimentalFeature;
  /** Help text of each sub-group, keyed by its dotted path below the noun, e.g. `"tables.layout"`. */
  readonly groups?: Readonly<Record<string, string>>;
}

/** How to tell that the resource a read operation returns has settled. */
export type ApiCommandPoll = Pick<ApiCommandWait, "status" | "succeeded" | "failed" | "error">;

/** Only these operations generate commands; `x-operation` on any other operation is ignored, except on a `pollTargets` key. */
export const generatedOperations: ReadonlyArray<OpenApiOperationId> = [
  "v2-get-warehouse-status",
  "v2-get-warehouse-connection",
  "v2-enable-warehouse",
  "v2-disable-warehouse",
  "v2-get-warehouse-teardown",
];

/** Hidden polling operations a generated link may target, each with the generated operation whose command inspects its state. */
export const pollTargets: Readonly<Partial<Record<OpenApiOperationId, OpenApiOperationId>>> = {
  "v2-get-warehouse-setup": "v2-get-warehouse-status",
};

export const nouns = {
  warehouse: {
    description: "Manage the data warehouse for a project",
    feature: "warehouse",
    groups: {
      teardowns: "Inspect Warehouse cleanup operations",
    },
  },
} as const satisfies Readonly<Record<string, ApiNoun>>;
