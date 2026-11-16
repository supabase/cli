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
] as const;

export interface ApiNoun {
  readonly description: string;
  /** Feature that gates every command under the noun. */
  readonly feature?: string;
}

/** How to tell that the resource a read operation returns has settled. */
export type ApiCommandPoll = Pick<ApiCommandWait, "status" | "succeeded" | "failed" | "error">;

/**
 * CLI-only metadata of one operation; its `group`, `method` and `poll` win over the spec's
 * `x-operation`.
 */
export interface ApiCommandOverride {
  /** A single noun, e.g. `warehouse`; it must be a key of `nouns`. */
  readonly group?: string;
  /** A member of `verbVocabulary`. */
  readonly method?: string;
  /** API field name to flag name; wins over the naming convention. */
  readonly flags?: Readonly<Record<string, string>>;
  /** Credential-like body fields that were reviewed and are secrets. */
  readonly sensitive?: readonly string[];
  /** Set on a read operation; response `links` that target it derive a `--wait`. */
  readonly poll?: ApiCommandPoll;
  /** Replaces any wait derived from response `links`. */
  readonly wait?: ApiCommandWait;
}

/** Only these operations generate commands; `x-operation` on any other operation is ignored. */
export const generatedOperations: ReadonlyArray<OpenApiOperationId> = [
  "v2-enable-warehouse",
  "v2-get-warehouse-setup",
];

export const nouns = {
  warehouse: { description: "Manage the data warehouse for a project", feature: "warehouse" },
} as const satisfies Readonly<Record<string, ApiNoun>>;

export const commandOverrides = {} as const satisfies Partial<
  Record<OpenApiOperationId, ApiCommandOverride>
>;
