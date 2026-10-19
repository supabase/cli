import { Option, Result } from "effect";

import { rootCommandForFeatures } from "../../src/cli/root.ts";
import { readPermissions } from "../../src/command-internal/command-permissions/command-permissions.annotation.ts";
import type {
  CommandPermissions,
  DbTarget,
  EntryCondition,
  OperationEntry,
  SelectorShape,
} from "../../src/command-internal/command-permissions/model.ts";
import { BRANCH_UUID_PATTERN } from "../../src/command-internal/ref-patterns.ts";
import { classifyRemoteValue } from "../../src/command-internal/target/remote-value.ts";
import { DB_URL_PATTERN } from "../../src/command-internal/target/remote-vocabulary.ts";
import { parseTargetSelector } from "../../src/command-internal/target/target-selector.ts";
import { findCommand } from "../../src/shared/cli/command-docs.ts";

/** Which command tree to resolve against: `start`/`status`/`stop` differ by stack backend. */
export type PermissionVariant = Parameters<typeof rootCommandForFeatures>[0];

/**
 * The flags one run uses, keyed by name without the leading `--`: a switch's effective value
 * (its default included) where an `is` condition checks it, a string where a `oneOf` condition
 * checks the value, otherwise `true`. List only the database-target flags (`remote`, `db-url`,
 * `local`, `linked`) the run was given: the CLI treats one as set whenever it appears on the
 * command line. `remote` is `true` when bare, else the value it was given.
 */
export type ActiveFlags = Readonly<Record<string, boolean | string>>;

/** The flags that select a database target, in precedence order. */
export const DB_TARGET_FLAGS = ["db-url", "local", "linked", "remote"] as const;

/** The flags that carry a target selector, whichever spelling the run used. */
export const SELECTOR_FLAGS = [
  "remote",
  "linked",
  "project-ref",
  "project-id",
  "db-url",
  "local",
] as const;

const optionalText = (value: boolean | string | undefined): Option.Option<string> =>
  typeof value === "string" ? Option.some(value) : Option.none();

/** The shape of the target selector `activeFlags` carries, read the way the CLI parses it. */
function selectorShapeOf(activeFlags: ActiveFlags): SelectorShape {
  const given = (flag: string) => {
    const value = Object.hasOwn(activeFlags, flag) ? activeFlags[flag] : undefined;
    return value === "" ? undefined : value;
  };
  if (given("project-ref") === true || given("project-id") === true) {
    throw new Error(
      "activeFlags gives --project-ref/--project-id as `true`; pass the value, since its shape picks the entries that apply",
    );
  }
  const remote = given("remote");
  const parsed = parseTargetSelector({
    local: given("local") !== undefined,
    linked: given("linked") !== undefined,
    remote:
      typeof remote === "string"
        ? Option.fromNullishOr(classifyRemoteValue(remote))
        : Option.fromNullishOr(remote === undefined ? undefined : ({ _tag: "Linked" } as const)),
    projectRef: optionalText(given("project-ref")),
    projectId: optionalText(given("project-id")),
    dbUrl: optionalText(given("db-url")),
  });
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  const { selection } = parsed.success;
  switch (selection._tag) {
    case "Default":
    case "Local":
      return "none";
    case "Linked":
      return "bare";
    case "Ref":
      return "ref";
    case "DbUrl":
      return "url";
    case "Branch":
      return BRANCH_UUID_PATTERN.test(selection.name) ? "uuid" : "branch";
  }
}

/** The target `activeFlags` selects (`db-url`, `local`, `linked`, `remote`, or `project-ref`, which imply linked unless `remote` is a database URL), else `fallback`. */
function dbTargetOf(
  activeFlags: ActiveFlags,
  fallback: DbTarget | undefined,
): DbTarget | undefined {
  for (const flag of ["db-url", "local", "linked"] as const satisfies ReadonlyArray<DbTarget>) {
    if (Object.hasOwn(activeFlags, flag)) return flag;
  }
  if (Object.hasOwn(activeFlags, "remote")) {
    const remote = activeFlags["remote"];
    return typeof remote === "string" && DB_URL_PATTERN.test(remote) ? "db-url" : "linked";
  }
  if (Object.hasOwn(activeFlags, "project-ref")) return "linked";
  return fallback;
}

function conditionHolds(
  condition: EntryCondition,
  activeFlags: ActiveFlags,
  dbTarget: () => DbTarget,
): boolean {
  if (condition.dbTarget !== undefined) return condition.dbTarget.includes(dbTarget());
  if (condition.selector !== undefined) {
    return condition.selector.includes(selectorShapeOf(activeFlags));
  }
  const value = Object.hasOwn(activeFlags, condition.flag)
    ? activeFlags[condition.flag]
    : undefined;
  if (condition.oneOf !== undefined) {
    return typeof value === "string" && condition.oneOf.includes(value);
  }
  if (condition.is !== undefined) return (value ?? false) === condition.is;
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

/** The entries of `permissions` that apply under `activeFlags`, one per declaration (not deduped). */
export function applicableEntries(
  permissions: MappedCommandPermissions,
  activeFlags: ActiveFlags,
): ReadonlyArray<OperationEntry> {
  const dbTarget = (): DbTarget => {
    const target = dbTargetOf(activeFlags, permissions.dbTargetDefault);
    if (target === undefined) {
      throw new Error(
        "an entry checks the database target, but activeFlags names none of --remote, --db-url, --local, --linked and the declaration sets no default (withDbTarget)",
      );
    }
    return target;
  };
  return permissions.operations.filter(
    (entry) =>
      entry.when === undefined ||
      entry.when.every((cond) => conditionHolds(cond, activeFlags, dbTarget)),
  );
}

/** The entries of `permissions` that apply under `activeFlags`, deduped by `operationId`. */
export function applicableOperations(
  permissions: MappedCommandPermissions,
  activeFlags: ActiveFlags,
): ReadonlyArray<OperationEntry> {
  return dedupeOperations(applicableEntries(permissions, activeFlags));
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
