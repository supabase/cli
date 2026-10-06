/** Serializable description of the Management API operations a command may call, keyed by the spec's `operationId`. */

type PermissionKind = "required" | "best-effort";

/** A flag must be present (or absent, when `present: false`) for an entry to apply. */
export interface FlagCondition {
  readonly flag: string;
  readonly present?: boolean;
}

export interface OperationEntry {
  /** The spec's `operationId`, e.g. `"v1-list-all-secrets"`. */
  readonly operationId: string;
  readonly kind: PermissionKind;
  /** Every condition must hold for this entry to apply. */
  readonly when?: ReadonlyArray<FlagCondition>;
  /** A condition that isn't a flag, e.g. "only without a saved .temp/pooler-url". */
  readonly context?: string;
  readonly note?: string;
  /**
   * The building block this entry came from (set by {@link block}); absent for a command's own
   * entry. A block's `when` flag doesn't have to exist on every command that includes it.
   */
  readonly source?: string;
}

/** A reusable building block for API calls made by shared code, not a command handler itself. */
export interface PermissionFragment {
  readonly operations: ReadonlyArray<OperationEntry>;
  /** Flags this fragment contributes that never change which operations it calls. */
  readonly noApiEffectFlags?: ReadonlyArray<string>;
}

export type CommandPermissions =
  | {
      readonly status: "mapped";
      readonly operations: ReadonlyArray<OperationEntry>;
      readonly noApiEffectFlags: ReadonlyArray<string>;
    }
  | { readonly status: "unmapped"; readonly reason: "go-delegated" };

/**
 * Builds a named building block, tagging every entry with `source` so a command that includes it
 * doesn't have to accept every flag the block's own conditions mention (see {@link OperationEntry.source}).
 */
export function block(
  source: string,
  operations: ReadonlyArray<Omit<OperationEntry, "source">>,
  noApiEffectFlags?: ReadonlyArray<string>,
): PermissionFragment {
  return {
    operations: operations.map((entry) => ({ ...entry, source })),
    noApiEffectFlags,
  };
}

/** Merges fragments' operations and `noApiEffectFlags` into one, preserving entry order. */
export function compose(...fragments: ReadonlyArray<PermissionFragment>): PermissionFragment {
  return {
    operations: fragments.flatMap((fragment) => fragment.operations),
    noApiEffectFlags: fragments.flatMap((fragment) => fragment.noApiEffectFlags ?? []),
  };
}

/** Adds `condition` to every operation entry in `fragment`, ahead of each entry's own `when`. */
export function withCondition(
  fragment: PermissionFragment,
  condition: FlagCondition,
): PermissionFragment {
  return {
    operations: fragment.operations.map((entry) => ({
      ...entry,
      when: [condition, ...(entry.when ?? [])],
    })),
    noApiEffectFlags: fragment.noApiEffectFlags,
  };
}

/** Builds a `"mapped"` {@link CommandPermissions} from a fragment, e.g. the result of {@link compose}. */
export function mapped(fragment: PermissionFragment): CommandPermissions {
  return {
    status: "mapped",
    operations: fragment.operations,
    noApiEffectFlags: fragment.noApiEffectFlags ?? [],
  };
}
