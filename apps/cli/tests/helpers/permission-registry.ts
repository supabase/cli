import { Option } from "effect";

import { rootCommandForFeatures } from "../../src/cli/root.ts";
import { readPermissions } from "../../src/command-internal/command-permissions/command-permissions.annotation.ts";
import type {
  CommandPermissions,
  DbTarget,
  EntryCondition,
  OperationEntry,
} from "../../src/command-internal/command-permissions/model.ts";
import { findCommand } from "../../src/shared/cli/command-docs.ts";

/** Which command tree to resolve against: `start`/`status`/`stop` differ by stack backend. */
export type PermissionVariant = Parameters<typeof rootCommandForFeatures>[0];

/**
 * The flags one run uses, keyed by name without the leading `--`: a switch's effective value
 * (its default included) where an `is` condition checks it, a string where a `oneOf` condition
 * checks the value, otherwise `true`. A database-target flag (`db-url`, `local`, `linked`) counts
 * when it is `true` or a non-empty string.
 */
export type ActiveFlags = Readonly<Record<string, boolean | string>>;

/** The flags that select a database target, in precedence order. */
export const DB_TARGET_FLAGS = [
  "db-url",
  "local",
  "linked",
] as const satisfies ReadonlyArray<DbTarget>;

/** The target `activeFlags` selects (`db-url`, then `local`, then `linked`), else `fallback`. */
function dbTargetOf(
  activeFlags: ActiveFlags,
  fallback: DbTarget | undefined,
): DbTarget | undefined {
  for (const flag of DB_TARGET_FLAGS) {
    const value = Object.hasOwn(activeFlags, flag) ? activeFlags[flag] : undefined;
    if (value === true || (typeof value === "string" && value !== "")) return flag;
  }
  return fallback;
}

function conditionHolds(
  condition: EntryCondition,
  activeFlags: ActiveFlags,
  dbTarget: () => DbTarget,
): boolean {
  if (condition.dbTarget !== undefined) return condition.dbTarget.includes(dbTarget());
  const value = Object.hasOwn(activeFlags, condition.flag)
    ? activeFlags[condition.flag]
    : undefined;
  if (condition.oneOf !== undefined) {
    return typeof value === "string" && condition.oneOf.includes(value);
  }
  if (condition.is !== undefined) return value === condition.is;
  return (value !== undefined && value !== "") === (condition.present ?? true);
}

/** Higher wins a dedupe conflict: a required check with no `context` must never lose to one that has one. */
function dedupeRank(entry: OperationEntry): number {
  if (entry.kind === "best-effort") return 0;
  return entry.context === undefined ? 2 : 1;
}

/** Dedupes entries sharing an `operationId`, keeping the higher-ranked one on a conflict (see {@link dedupeRank}). */
function dedupeOperations(
  operations: ReadonlyArray<OperationEntry>,
): ReadonlyArray<OperationEntry> {
  const byId = new Map<string, OperationEntry>();
  for (const entry of operations) {
    const existing = byId.get(entry.operationId);
    if (existing === undefined || dedupeRank(entry) > dedupeRank(existing)) {
      byId.set(entry.operationId, entry);
    }
  }
  return [...byId.values()];
}

type MappedCommandPermissions = Extract<CommandPermissions, { status: "mapped" }>;

/** The entries of `permissions` that apply under `activeFlags`, deduped by `operationId`. */
export function applicableOperations(
  permissions: MappedCommandPermissions,
  activeFlags: ActiveFlags,
): ReadonlyArray<OperationEntry> {
  const dbTarget = (): DbTarget => {
    const target = dbTargetOf(activeFlags, permissions.dbTargetDefault);
    if (target === undefined) {
      throw new Error(
        "an entry checks the database target, but activeFlags names none of --db-url, --local, --linked and the declaration sets no default (withDbTarget)",
      );
    }
    return target;
  };
  const applicable = permissions.operations.filter(
    (entry) =>
      entry.when === undefined ||
      entry.when.every((cond) => conditionHolds(cond, activeFlags, dbTarget)),
  );
  return dedupeOperations(applicable);
}

export type DeclaredPermissionsLookup =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Undeclared" }
  | { readonly _tag: "Declared"; readonly permissions: CommandPermissions };

/**
 * The `withPermissions` declaration of the command at `path` in the `variant` command tree,
 * conditions unevaluated. `NotFound` means `path` isn't in this tree; `Undeclared` means it is
 * but carries no declaration.
 */
export function declaredPermissions(
  path: string,
  variant?: PermissionVariant,
): DeclaredPermissionsLookup {
  const command = findCommand(rootCommandForFeatures(variant), path.split(" "));
  if (command === undefined) return { _tag: "NotFound" };
  const permissions = Option.getOrUndefined(readPermissions(command));
  return permissions === undefined ? { _tag: "Undeclared" } : { _tag: "Declared", permissions };
}
