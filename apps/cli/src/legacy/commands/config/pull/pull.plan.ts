import {
  type ConfigChange,
  type ConfigChangeSet,
  type ConfigEditValue,
  dualScopeProjectConfigPaths,
} from "@supabase/config/internal";

import type { LegacyConfigPullDestination } from "./pull.scope.ts";

/**
 * `config pull`'s write plan: classifies every `ConfigChange` `config diff`'s
 * classifier already computed (CLI-2230/ADR-0022's convergence normalizer)
 * into a planned write (replace or insert) or a skip with a reason, and
 * derives the warnings a written value should carry. Pure and synchronous
 * (CLI-2064) — no Effect, no services, no filesystem: this module only
 * decides WHAT would change and WHERE (`documentPath`); applying it is
 * `applyConfigEdits`'s job (`@supabase/config/internal`), and running it is
 * `pull.handler.ts`'s.
 */

export type LegacyConfigPullSkipReason = "env_reference" | "local_only" | "unwritable";

export interface LegacyConfigPullSkip {
  readonly change: ConfigChange;
  readonly reason: LegacyConfigPullSkipReason;
}

export interface LegacyConfigPullPlannedWrite {
  readonly change: ConfigChange;
  /** `change.path`, prefixed with `["remotes", label]` when the destination
   * is a `[remotes.*]` block — the exact path `applyConfigEdits` edits. */
  readonly documentPath: ReadonlyArray<string>;
  readonly value: ConfigEditValue;
}

export type LegacyConfigPullWarningKind =
  | "dual_scope"
  | "duplicates_root"
  | "array_drift"
  | "uncommitted_changes";

export interface LegacyConfigPullWarning {
  readonly kind: LegacyConfigPullWarningKind;
  /**
   * Absent for `uncommitted_changes` — a repository-level warning, not a
   * per-path one, constructed by `pull.handler.ts`'s own git dirty check
   * (`§1.4`). This module only ever produces the three path-bearing kinds
   * below, always with `path` set.
   */
  readonly path?: ReadonlyArray<string>;
}

export interface LegacyConfigPullPlan {
  readonly writes: ReadonlyArray<LegacyConfigPullPlannedWrite>;
  readonly skipped: ReadonlyArray<LegacyConfigPullSkip>;
  readonly warnings: ReadonlyArray<LegacyConfigPullWarning>;
  /**
   * `["remotes", label]` when `destination` creates a brand new block,
   * `undefined` otherwise — surfaced so a caller composing a message doesn't
   * need to re-derive it from `destination` itself.
   */
  readonly createdTable: ReadonlyArray<string> | undefined;
}

export interface LegacyPlanConfigPullInput {
  readonly changeSet: ConfigChangeSet;
  readonly destination: LegacyConfigPullDestination;
  /**
   * The BASE config document — loaded with NO `[remotes.*]` overlay applied,
   * regardless of `destination` — used only to detect `duplicates_root`/
   * `array_drift` (comparing a REMOTE-block write against what the config
   * ROOT independently declares, which `changeSet`'s own operand cannot: it
   * was diffed against whichever document `destination` itself resolved
   * from, overlay included).
   */
  readonly rootDocument: Readonly<Record<string, unknown>>;
  /** Carried for parity with `legacyResolveConfigPullDestination`'s own input
   * shape; not otherwise consulted by the planner (every path-scoped
   * decision is already fully determined by `changeSet` + `destination` +
   * `rootDocument`). */
  readonly projectRef: string;
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isDeclaredAtPath(root: unknown, path: ReadonlyArray<string>): boolean {
  let current: unknown = root;
  for (const [index, segment] of path.entries()) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    if (index < path.length - 1) {
      current = current[segment];
    }
  }
  return true;
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqualValue(value, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqualValue(a[key], b[key]))
    );
  }
  return false;
}

function isConfigEditValue(value: unknown): value is ConfigEditValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(
      (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
  }
  if (isPlainRecord(value)) {
    return Object.values(value).every((child) => isConfigEditValue(child));
  }
  return false;
}

const dualScopePathKeys: ReadonlySet<string> = new Set(dualScopeProjectConfigPaths.map(pathKey));

/**
 * Prefix-aware, mirroring `isComparableProjectConfigPath` — a mapped
 * container's descendant leaves (e.g. `sms.test_otp`'s per-number keys)
 * inherit its dual-scope membership too.
 */
function isDualScopePath(path: ReadonlyArray<string>): boolean {
  for (let length = path.length; length >= 1; length--) {
    if (dualScopePathKeys.has(pathKey(path.slice(0, length)))) {
      return true;
    }
  }
  return false;
}

function documentPathFor(
  destination: LegacyConfigPullDestination,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return destination.kind === "remote" ? ["remotes", destination.label, ...path] : path;
}

/**
 * Classifies every comparable `ConfigChange` into a planned write or a skip,
 * then derives per-write warnings. Skip precedence (checked in this order):
 * a `local_only` change never has a remote value to write; an `env_reference`
 * change (the local declared value resolved from `env()`) is NEVER replaced,
 * regardless of class, so the user's env-var indirection is never silently
 * erased; the remaining `unwritable` case only arises for a remote value
 * `applyConfigEdits` cannot represent (`undefined`/`null`, or a shape outside
 * `ConfigEditValue`) — expected to be rare given the registry's mapped
 * value domains, but never assumed impossible.
 *
 * `masked`/`unmanaged` paths never reach `changeSet.changes` by construction
 * (`diffProjectConfig` excludes both before classification), so they never
 * need a skip reason here — asserted by construction, not re-checked.
 */
export function legacyPlanConfigPull(input: LegacyPlanConfigPullInput): LegacyConfigPullPlan {
  const writes: Array<LegacyConfigPullPlannedWrite> = [];
  const skipped: Array<LegacyConfigPullSkip> = [];

  for (const change of input.changeSet.changes) {
    if (change.class === "local_only") {
      skipped.push({ change, reason: "local_only" });
      continue;
    }
    if (change.envVariables !== undefined && change.envVariables.length > 0) {
      skipped.push({ change, reason: "env_reference" });
      continue;
    }
    if (!isConfigEditValue(change.remote)) {
      skipped.push({ change, reason: "unwritable" });
      continue;
    }
    writes.push({
      change,
      documentPath: documentPathFor(input.destination, change.path),
      value: change.remote,
    });
  }

  const warnings: Array<LegacyConfigPullWarning> = [];
  for (const write of writes) {
    if (input.destination.kind === "root" && isDualScopePath(write.change.path)) {
      // Writing a dual-scope path to the config ROOT silently reconfigures
      // `supabase start` too — both a replace (declared locally, differing
      // from remote) and an insert (undeclared locally) carry this risk: the
      // local default IS a legitimate local-dev value in its own right.
      warnings.push({ kind: "dual_scope", path: write.change.path });
      continue;
    }
    if (input.destination.kind !== "remote") {
      continue;
    }
    const rootValue = valueAtPath(input.rootDocument, write.change.path);
    if (deepEqualValue(write.value, rootValue)) {
      warnings.push({ kind: "duplicates_root", path: write.change.path });
    }
    if (
      write.change.class === "remote_only" &&
      Array.isArray(write.value) &&
      isDeclaredAtPath(input.rootDocument, write.change.path)
    ) {
      // Arrays REPLACE wholesale on override, never merge — giving
      // `[remotes.*]` its own copy of a path the config root ALSO declares
      // means the two copies can silently diverge from this point on.
      warnings.push({ kind: "array_drift", path: write.change.path });
    }
  }

  const createdTable: ReadonlyArray<string> | undefined =
    input.destination.kind === "remote" && input.destination.created
      ? ["remotes", input.destination.label]
      : undefined;

  return { writes, skipped, warnings, createdTable };
}
