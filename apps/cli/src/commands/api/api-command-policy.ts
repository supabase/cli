import type { OpenApiOperationId } from "@supabase/api/effect";
import type { ExperimentalFeature } from "../../shared/config/experimental-feature.ts";

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
  /** Help text of the noun's group; set only when no hand-written group of that name exists. */
  readonly description?: string;
  /** Feature that gates every command under the noun. */
  readonly feature: ExperimentalFeature;
  /**
   * Help text of each sub-group the generator creates, keyed by its dotted path below the noun,
   * e.g. `"tables.layout"`; a sub-group that exists in a hand-written group has no entry.
   */
  readonly groups?: Readonly<Record<string, string>>;
}

/**
 * Hand-written groups that wrap their own subcommands after `Command.withSubcommands`, which a
 * generated command cannot join; each entry is a space-joined group path.
 */
export const sealedGroups: ReadonlySet<string> = new Set(["stack"]);

/** Only these operations generate commands, and their response `links` lead to the reads a `--wait` polls. */
export const generatedOperations: ReadonlyArray<OpenApiOperationId> = [
  "v2-get-warehouse-status",
  "v2-get-warehouse-connection",
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
    },
  },
} as const satisfies Readonly<Record<string, ApiNoun>>;
