import { Option } from "effect";

import { rootCommandForFeatures } from "../../src/cli/root.ts";
import { readPermissions } from "../../src/command-internal/command-permissions/command-permissions.annotation.ts";
import type {
  CommandPermissions,
  FlagCondition,
  OperationEntry,
} from "../../src/command-internal/command-permissions/model.ts";
import { findCommand } from "../../src/shared/cli/command-docs.ts";

/** Which command tree to resolve against: `start`/`status`/`stop` differ by stack backend. */
export type PermissionVariant = Parameters<typeof rootCommandForFeatures>[0];

/**
 * The flags one run uses, keyed by name without the leading `--`: a flag's effective value
 * (its default included) where a value condition checks it, otherwise `true`.
 */
export type ActiveFlags = Readonly<Record<string, true | string>>;

function conditionHolds(condition: FlagCondition, activeFlags: ActiveFlags): boolean {
  const value = Object.hasOwn(activeFlags, condition.flag)
    ? activeFlags[condition.flag]
    : undefined;
  if (condition.oneOf !== undefined) {
    return typeof value === "string" && condition.oneOf.includes(value);
  }
  return (value !== undefined) === (condition.present ?? true);
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

/** The entries of `permissions` that apply under `activeFlags`, deduped by `operationId`. */
export function applicableOperations(
  permissions: CommandPermissions,
  activeFlags: ActiveFlags,
): ReadonlyArray<OperationEntry> {
  const applicable = permissions.operations.filter(
    (entry) =>
      entry.when === undefined || entry.when.every((cond) => conditionHolds(cond, activeFlags)),
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
