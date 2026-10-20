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
  readonly selector?: never;
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

type FlagCondition = PresenceCondition | SwitchCondition | ValueCondition;

/**
 * The target a command talks to: the local stack, a database URL, or a hosted project. `seed
 * buckets` uses it for its Storage target, which `--remote`/`--local` select the same way.
 */
export type DbTarget = "local" | "db-url" | "linked";

/**
 * The run's database target must be one of `dbTarget` for an entry to apply. The target is
 * `--db-url` (or `--remote=<url>`) if given, else `--local`, else `--linked`, `--project-ref` or
 * any other `--remote`, else the local stack. As with {@link FlagCondition}, `source` marks a
 * building block's condition.
 */
interface DbTargetCondition {
  readonly dbTarget: ReadonlyArray<DbTarget>;
  readonly source?: string;
  readonly selector?: never;
  readonly flag?: never;
  readonly present?: never;
  readonly is?: never;
  readonly oneOf?: never;
}

/** What the target selector carries once the deprecated aliases are folded in; `bare` is `--remote` or `--linked` with no value, `uuid` a branch's UUID. */
export type SelectorShape = "none" | "bare" | "ref" | "branch" | "uuid" | "url";

/** Holds when the selector's shape is one of `selector`, whichever flag spelled it. */
interface SelectorCondition {
  readonly selector: ReadonlyArray<SelectorShape>;
  readonly source?: string;
  readonly dbTarget?: never;
  readonly flag?: never;
  readonly present?: never;
  readonly is?: never;
  readonly oneOf?: never;
}

export type EntryCondition = FlagCondition | DbTargetCondition | SelectorCondition;

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
 * keeps no block `source`, so a flag condition must name a flag of the command that declares it,
 * and a target condition a target that command can select.
 */
export function withCondition(
  fragment: PermissionFragment,
  condition: EntryCondition,
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
 * Adds `prerequisite` to every entry's `context`, for a condition that isn't a flag, e.g. a choice
 * the user makes at a prompt.
 */
export function withContext(
  fragment: PermissionFragment,
  prerequisite: string,
): PermissionFragment {
  return {
    ...fragment,
    operations: fragment.operations.map((entry) => ({
      ...entry,
      context: entry.context === undefined ? prerequisite : `${prerequisite}, and ${entry.context}`,
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

/** Builds a `"mapped"` {@link CommandPermissions} from a fragment, e.g. the result of {@link compose}. */
export function mapped(fragment: PermissionFragment): CommandPermissions {
  return {
    status: "mapped",
    operations: fragment.operations,
    noApiEffectFlags: fragment.noApiEffectFlags ?? [],
  };
}
