/** Serializable description of the Management API operations a command may call, keyed by the spec's `operationId`. */

type PermissionKind = "required" | "best-effort";

interface FlagConditionBase {
  readonly flag: string;
  /**
   * The building block that wrote this condition (set by {@link block}). A block's condition may
   * name a flag the including command lacks; a condition without `source`, including one added
   * by {@link withCondition}, must name a flag of the command it's declared on.
   */
  readonly source?: string;
}

/**
 * The flag must be present (or absent, when `present: false`) for an entry to apply. A flag given
 * an empty value counts as absent.
 */
interface PresenceCondition extends FlagConditionBase {
  readonly present?: boolean;
  readonly oneOf?: never;
  readonly is?: never;
}

/** The switch's effective value, default included, must equal `is` for an entry to apply. */
interface SwitchCondition extends FlagConditionBase {
  readonly is: boolean;
  readonly present?: never;
  readonly oneOf?: never;
}

/**
 * The flag's value must be one of `oneOf` for an entry to apply. For a flag with a default, the
 * effective value counts, so a run that omits `--lang` still matches `oneOf: ["typescript"]`.
 */
interface ValueCondition extends FlagConditionBase {
  readonly oneOf: ReadonlyArray<string>;
  readonly present?: never;
  readonly is?: never;
}

export type FlagCondition = PresenceCondition | SwitchCondition | ValueCondition;

export interface OperationEntry {
  /** The spec's `operationId`, e.g. `"v1-list-all-secrets"`. */
  readonly operationId: string;
  readonly kind: PermissionKind;
  /** Every condition must hold for this entry to apply. */
  readonly when?: ReadonlyArray<FlagCondition>;
  /** A condition that isn't a flag, e.g. "only without a saved .temp/pooler-url". */
  readonly context?: string;
  readonly note?: string;
  /** The building block this entry came from (set by {@link block}); absent for a command's own entry. */
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
 * Builds a named building block for Management API calls a shared module makes on behalf of its
 * callers, tagging every entry and each of its conditions with `source` (see
 * {@link FlagConditionBase.source}). Declare it next to the module that makes the calls; a command
 * includes the blocks its handler reaches with {@link compose}, adding its own condition (e.g.
 * `--linked`) with {@link withCondition} where the module is only used on that path.
 */
export function block(
  source: string,
  operations: ReadonlyArray<Omit<OperationEntry, "source">>,
  noApiEffectFlags?: ReadonlyArray<string>,
): PermissionFragment {
  return {
    operations: operations.map((entry) => ({
      ...entry,
      ...(entry.when === undefined
        ? {}
        : { when: entry.when.map((cond) => ({ ...cond, source: cond.source ?? source })) }),
      source,
    })),
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

/**
 * Adds `condition` to every operation entry in `fragment`, ahead of each entry's own `when`. It
 * keeps no block `source`, so it must name a flag of the command that declares it.
 */
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
