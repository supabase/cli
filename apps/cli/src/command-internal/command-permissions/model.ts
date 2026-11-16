/** Serializable description of the Management API operations a command may call, keyed by the spec's `operationId`. */

/** `best-effort` keeps the command's result on a 403; anything else is `required`. */
type PermissionKind = "required" | "best-effort";

interface FlagConditionBase {
  readonly flag: string;
  /** The block that wrote this condition; absent, the flag must belong to the declaring command. */
  readonly source?: string;
  readonly dbTarget?: never;
  readonly selector?: never;
}

/** The flag must be present (or absent, with `present: false`); an empty value counts as absent. */
interface PresenceCondition extends FlagConditionBase {
  readonly present?: boolean;
  readonly oneOf?: never;
  readonly is?: never;
}

/** The switch's effective value, default included, must equal `is`; a missing switch is `false`. */
interface SwitchCondition extends FlagConditionBase {
  readonly is: boolean;
  readonly present?: never;
  readonly oneOf?: never;
}

/** The flag's effective value, default included, must be one of `oneOf`. */
interface ValueCondition extends FlagConditionBase {
  readonly oneOf: ReadonlyArray<string>;
  readonly present?: never;
  readonly is?: never;
}

type FlagCondition = PresenceCondition | SwitchCondition | ValueCondition;

/** The target a command talks to: the local stack, a database URL, or a hosted project. */
export type DbTarget = "local" | "db-url" | "linked";

/**
 * The run's database target must be one of `dbTarget`: `--db-url` or `--remote=<url>`, else
 * `--local`, else a linked selector, else the local stack.
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

/** The selector's shape after folding in the deprecated aliases; `bare` carries no value. */
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

/** The parts of a request a permission can depend on, string-encoded like the request on the wire. */
export interface RequestDetails {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
}

export interface OperationEntry {
  /** The spec's `operationId`, e.g. `"v1-list-all-secrets"`. */
  readonly operationId: string;
  readonly kind: PermissionKind;
  /** Every condition must hold for this entry to apply. */
  readonly when?: ReadonlyArray<EntryCondition>;
  /** A condition that isn't a flag, e.g. "only without a saved .temp/pooler-url". */
  readonly context?: string;
  /** Request details a permission can depend on, e.g. `reveal=true` on the api-keys call. */
  readonly request?: RequestDetails;
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

/** A shared module's calls, tagged with `source`; commands include it via {@link compose}. */
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

/** Prepends `condition` to each `when`; it must name a flag or target the command declares. */
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

/** Adds `prerequisite` to each entry's `context`, for a non-flag condition like a prompt choice. */
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
 * Overrides every entry's `kind` with the one the including command handles it with.
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
