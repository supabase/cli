/** Serializable description of the Management API operations a command may call, keyed by the spec's `operationId`. */

/**
 * Whether a command's useful result depends on the call. `best-effort` means a 403 on the call
 * still leaves the command's useful result; anything else is `required`.
 */
type PermissionKind = "required" | "best-effort";

interface FlagConditionBase {
  readonly flag: string;
  /**
   * The building block that wrote this condition (set by {@link block}). A block's condition may
   * name a flag the including command lacks; a condition without `source`, including one added
   * by {@link withCondition}, must name a flag of the command it's declared on.
   */
  readonly source?: string;
  readonly dbTarget?: never;
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

/**
 * The switch's effective value, default included, must equal `is` for an entry to apply. A switch
 * the including command lacks counts as `false`.
 */
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

/** The database a command talks to: `--local`, `--db-url`, or the linked project. */
export type DbTarget = "local" | "db-url" | "linked";

/**
 * The run's database target must be one of `dbTarget` for an entry to apply. The target is
 * `--db-url` if given, else `--local`, else `--linked`, else the default set with
 * {@link withDbTarget}. As with {@link FlagCondition}, `source` marks a building block's condition.
 */
interface DbTargetCondition {
  readonly dbTarget: ReadonlyArray<DbTarget>;
  readonly source?: string;
  readonly flag?: never;
  readonly present?: never;
  readonly is?: never;
  readonly oneOf?: never;
}

export type EntryCondition = FlagCondition | DbTargetCondition;

export interface OperationEntry {
  /** The spec's `operationId`, e.g. `"v1-list-all-secrets"`. */
  readonly operationId: string;
  readonly kind: PermissionKind;
  /** Every condition must hold for this entry to apply. */
  readonly when?: ReadonlyArray<EntryCondition>;
  /** A condition that isn't a flag, e.g. "only without a saved .temp/pooler-url". */
  readonly context?: string;
  /** Request details a permission can depend on, e.g. `reveal=true` on the api-keys call. */
  readonly request?: { readonly query?: Readonly<Record<string, string>> };
  /** The building block this entry came from (set by {@link block}); absent for a command's own entry. */
  readonly source?: string;
}

/** A reusable building block for API calls made by shared code, not a command handler itself. */
export interface PermissionFragment {
  readonly operations: ReadonlyArray<OperationEntry>;
  /** Flags this fragment contributes that never change which operations it calls. */
  readonly noApiEffectFlags?: ReadonlyArray<string>;
  /** Which database the command targets when no target flag is given; see {@link withDbTarget}. */
  readonly dbTargetDefault?: "local" | "linked";
}

export type CommandPermissions =
  | {
      readonly status: "mapped";
      readonly operations: ReadonlyArray<OperationEntry>;
      readonly noApiEffectFlags: ReadonlyArray<string>;
      readonly dbTargetDefault?: "local" | "linked";
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
  const defaults = new Set(fragments.flatMap((fragment) => fragment.dbTargetDefault ?? []));
  if (defaults.size > 1) {
    throw new Error(
      `compose: fragments disagree on the default database target (${[...defaults]})`,
    );
  }
  const [dbTargetDefault] = defaults;
  return {
    operations: fragments.flatMap((fragment) => fragment.operations),
    noApiEffectFlags: fragments.flatMap((fragment) => fragment.noApiEffectFlags ?? []),
    ...(dbTargetDefault === undefined ? {} : { dbTargetDefault }),
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
    ...fragment,
    operations: fragment.operations.map((entry) => ({
      ...entry,
      when: [condition, ...(entry.when ?? [])],
    })),
  };
}

/**
 * Gives every entry in `fragment` the `kind` the including command handles it with, when that
 * differs from the block's own (e.g. a command that carries on after a 403 on a call its
 * block treats as required).
 *
 * @public
 */
export function withKind(fragment: PermissionFragment, kind: PermissionKind): PermissionFragment {
  return {
    ...fragment,
    operations: fragment.operations.map((entry) => ({ ...entry, kind })),
  };
}

/**
 * Sets the database a command targets when no `--db-url`, `--local` or `--linked` flag is given,
 * for entries with a {@link DbTargetCondition}.
 *
 * @public
 */
export function withDbTarget(
  fragment: PermissionFragment,
  options: { readonly default: "local" | "linked" },
): PermissionFragment {
  return { ...fragment, dbTargetDefault: options.default };
}

/** Builds a `"mapped"` {@link CommandPermissions} from a fragment, e.g. the result of {@link compose}. */
export function mapped(fragment: PermissionFragment): CommandPermissions {
  return {
    status: "mapped",
    operations: fragment.operations,
    noApiEffectFlags: fragment.noApiEffectFlags ?? [],
    ...(fragment.dbTargetDefault === undefined
      ? {}
      : { dbTargetDefault: fragment.dbTargetDefault }),
  };
}
