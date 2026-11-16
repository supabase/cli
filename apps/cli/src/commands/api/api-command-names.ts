import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ApiCommandWait } from "./api-command.model.ts";

/** Verbs every generated command may use; anything else needs `customVerb`. */
export const verbVocabulary = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
] as const;

export interface ApiNoun {
  readonly description: string;
  /** Feature that gates every command under the noun. */
  readonly feature?: string;
}

export interface ApiCommandName {
  /** Dot-separated noun path, e.g. `warehouse`. Its first segment must be a key of `nouns`. */
  readonly group: string;
  readonly method: string;
  /** Allows a `method` outside `verbVocabulary`. */
  readonly customVerb?: true;
  /** API field name to flag name. */
  readonly flags?: Readonly<Record<string, string>>;
  /** Credential-like body fields that were reviewed and are secrets. */
  readonly sensitive?: readonly string[];
  readonly wait?: ApiCommandWait;
}

export const nouns = {
  warehouse: { description: "Manage the data warehouse for a project", feature: "warehouse" },
} as const satisfies Readonly<Record<string, ApiNoun>>;

export const commandNames = {
  "v2-enable-warehouse": {
    group: "warehouse",
    method: "enable",
    flags: { tables: "table" },
    wait: {
      read: "v2-get-warehouse-setup",
      params: { selection_id: "/data/attributes/selection_id" },
      status: "/data/attributes/status",
      succeeded: ["succeeded"],
      failed: ["failed"],
      error: "/data/attributes/status_error",
    },
  },
  "v2-get-warehouse-setup": { group: "warehouse", method: "status", customVerb: true },
} as const satisfies Partial<Record<OpenApiOperationId, ApiCommandName>>;
