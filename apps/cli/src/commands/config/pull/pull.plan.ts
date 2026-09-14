import {
  type CliConfigValueOrigin,
  type ConfigChange,
  type ConfigChangeSet,
  diffProjectConfig,
  type EffectiveConfig,
  type ProjectConfig,
} from "@supabase/config";
import {
  type ConfigEditValue,
  dualScopeProjectConfigPaths,
  ENV_CAPTURE_REGEX,
} from "@supabase/config/internal";

import {
  configDeepEqualValue,
  configDeepSetAtPath,
  configIsDeclaredAtPath,
  configIsRecord,
  configPathKey,
  configValueAtPath,
} from "../config.paths.ts";
import type { ConfigPullDestination } from "./pull.scope.ts";

/**
 * `config pull`'s write plan: classifies each `ConfigChange` `config diff` already computed into
 * a planned write (replace or insert) or a skip with a reason, and derives per-write warnings.
 * Pure and synchronous — no Effect, no services, no filesystem; applying the plan is
 * `applyConfigEdits`'s job, running it is `pull.handler.ts`'s.
 *
 * Also absorbs cascading writes: pulling a value can gate other declared-but-unpushable siblings
 * (e.g. enabling a disabled SMS provider un-gates its credentials). {@link
 * expandConfigPullChangeSet} re-classifies after each round's writes so a newly un-gated sibling
 * joins the same plan; {@link dropConfigPullUnvalidatableFamilies} drops every write under a
 * family that still fails schema validation once applied, rather than write an unloadable file.
 */

export type ConfigPullSkipReason =
  | "env_reference"
  | "local_only"
  | "remote_env_reference"
  | "unwritable"
  | "would_invalidate";

interface ConfigPullSkip {
  readonly change: ConfigChange;
  readonly reason: ConfigPullSkipReason;
}

interface ConfigPullPlannedWrite {
  readonly change: ConfigChange;
  /** `change.path`, prefixed with `["remotes", label]` when the destination
   * is a `[remotes.*]` block — the exact path `applyConfigEdits` edits. */
  readonly documentPath: ReadonlyArray<string>;
  readonly value: ConfigEditValue;
}

type ConfigPullWarningKind =
  | "dual_scope"
  | "duplicates_root"
  | "array_drift"
  | "uncommitted_changes"
  | "unpushable"
  | "would_invalidate";

/**
 * One field found still missing/invalid by the schema-validation gate, carried on a
 * `would_invalidate` warning so its note can name what actually blocked the family.
 */
export interface ConfigPullMissingField {
  readonly path: ReadonlyArray<string>;
  /** Set when this field's local (pre-pull) spelling is an unresolved `env(VAR)` reference —
   *  the variable name to surface in the note ("set VAR and rerun"). */
  readonly envVariable?: string;
}

export interface ConfigPullWarning {
  readonly kind: ConfigPullWarningKind;
  /**
   * Absent only for `uncommitted_changes` (a repository-level warning, constructed by
   * `pull.handler.ts`'s git dirty check). Every other kind always carries `path`, including
   * `unpushable` (built by `pull.handler.ts`'s post-plan convergence check) — still reachable via
   * `applyDisabledSentinels`'s cross-section pruning of `auth.rate_limit.email_sent`, so it is a
   * structural safety net, not dead code.
   */
  readonly path?: ReadonlyArray<string>;
  /** `would_invalidate` only — see {@link ConfigPullMissingField}. */
  readonly missingFields?: ReadonlyArray<ConfigPullMissingField>;
}

export interface ConfigPullPlan {
  readonly writes: ReadonlyArray<ConfigPullPlannedWrite>;
  readonly skipped: ReadonlyArray<ConfigPullSkip>;
  readonly warnings: ReadonlyArray<ConfigPullWarning>;
  /** `["remotes", label]` when `destination` creates a brand-new block, `undefined` otherwise. */
  readonly createdTable: ReadonlyArray<string> | undefined;
}

export interface PlanConfigPullInput {
  readonly changeSet: ConfigChangeSet;
  readonly destination: ConfigPullDestination;
  /**
   * The base config document, loaded with no `[remotes.*]` overlay regardless of `destination` —
   * used only to detect `duplicates_root`/`array_drift` by comparing a remote-block write
   * against what the config root independently declares.
   */
  readonly rootDocument: Readonly<Record<string, unknown>>;
  /** Carried for parity with `resolveConfigPullDestination`'s own input
   * shape; not otherwise consulted by the planner (every path-scoped
   * decision is already fully determined by `changeSet` + `destination` +
   * `rootDocument`). */
  readonly projectRef: string;
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
  if (configIsRecord(value)) {
    return Object.values(value).every((child) => isConfigEditValue(child));
  }
  return false;
}

/**
 * True when `value` — or any element/leaf inside it — is itself spelled as an unresolved
 * `env(VAR)` reference. Distinct from `change.envVariables` (which flags the local declaration):
 * writing a remote-controlled `env(...)` string verbatim would let the platform read whatever
 * this machine's environment holds at that variable name on the next load. The regex is anchored
 * (`^env\(...\)$`), so a substring mention doesn't match.
 */
function containsRemoteEnvReference(value: ConfigEditValue): boolean {
  if (typeof value === "string") {
    return ENV_CAPTURE_REGEX.test(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && ENV_CAPTURE_REGEX.test(item));
  }
  return Object.values(value).some((child) => containsRemoteEnvReference(child));
}

const dualScopePathKeys: ReadonlySet<string> = new Set(
  dualScopeProjectConfigPaths.map(configPathKey),
);

/**
 * Prefix-aware, mirroring `isComparableProjectConfigPath` — a mapped
 * container's descendant leaves (e.g. `sms.test_otp`'s per-number keys)
 * inherit its dual-scope membership too.
 */
function isDualScopePath(path: ReadonlyArray<string>): boolean {
  for (let length = path.length; length >= 1; length--) {
    if (dualScopePathKeys.has(configPathKey(path.slice(0, length)))) {
      return true;
    }
  }
  return false;
}

function documentPathFor(
  destination: ConfigPullDestination,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return destination.kind === "remote" ? ["remotes", destination.label, ...path] : path;
}

/**
 * Classifies every comparable `ConfigChange` into a planned write or a skip, then derives
 * per-write warnings. Skip precedence: `local_only` never has a remote value to write;
 * `env_reference` (a local value resolved from `env()`) is never replaced, regardless of class,
 * so the user's env-var indirection is never silently erased; `unwritable` covers a remote value
 * `applyConfigEdits` cannot represent; `remote_env_reference` (the remote value itself is an
 * unresolved `env(VAR)` reference) is never written either, since the loader would interpolate it
 * against the local environment on the next load ({@link containsRemoteEnvReference}).
 *
 * `masked`/`unmanaged` paths never reach `changeSet.changes` (`diffProjectConfig` excludes both
 * before classification), so they never need a skip reason here.
 */
export function planConfigPull(input: PlanConfigPullInput): ConfigPullPlan {
  const writes: Array<ConfigPullPlannedWrite> = [];
  const skipped: Array<ConfigPullSkip> = [];

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
    if (containsRemoteEnvReference(change.remote)) {
      skipped.push({ change, reason: "remote_env_reference" });
      continue;
    }
    writes.push({
      change,
      documentPath: documentPathFor(input.destination, change.path),
      value: change.remote,
    });
  }

  const warnings: Array<ConfigPullWarning> = [];
  for (const write of writes) {
    if (input.destination.kind === "root" && isDualScopePath(write.change.path)) {
      // Writing a dual-scope path to the config root also reconfigures `supabase start`; the
      // local default is a legitimate local-dev value in its own right.
      warnings.push({ kind: "dual_scope", path: write.change.path });
      continue;
    }
    if (input.destination.kind !== "remote") {
      continue;
    }
    const rootValue = configValueAtPath(input.rootDocument, write.change.path);
    if (configDeepEqualValue(write.value, rootValue)) {
      warnings.push({ kind: "duplicates_root", path: write.change.path });
    }
    if (
      write.change.class === "remote_only" &&
      Array.isArray(write.value) &&
      configIsDeclaredAtPath(input.rootDocument, write.change.path)
    ) {
      // Arrays replace wholesale on override, never merge, so giving [remotes.*] its own copy
      // of a path the config root also declares lets the two silently diverge.
      warnings.push({ kind: "array_drift", path: write.change.path });
    }
  }

  const createdTable: ReadonlyArray<string> | undefined =
    input.destination.kind === "remote" && input.destination.created
      ? ["remotes", input.destination.label]
      : undefined;

  return { writes, skipped, warnings, createdTable };
}

/**
 * Doesn't check {@link containsRemoteEnvReference}: this only gates what the fixpoint's internal
 * simulation below projects, never what reaches disk — `planConfigPull` is the sole gate for
 * that, and every change observed here still reaches it via `seen`.
 */
function isWritableChange(change: ConfigChange): boolean {
  return (
    change.class !== "local_only" &&
    !(change.envVariables !== undefined && change.envVariables.length > 0) &&
    isConfigEditValue(change.remote)
  );
}

/** Segment-wise path order, mirroring `@supabase/config`'s own `comparePaths`. */
function comparePaths(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index];
    const right = b[index];
    // Always defined here (index < length, the shorter array's bound); this check only
    // satisfies indexed-access typing without an `as` cast.
    if (left === undefined || right === undefined) {
      continue;
    }
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return a.length - b.length;
}

function countsFor(changes: ReadonlyArray<ConfigChange>): ConfigChangeSet["counts"] {
  const update = changes.filter((change) => change.class === "update").length;
  const remote_only = changes.filter((change) => change.class === "remote_only").length;
  const local_only = changes.filter((change) => change.class === "local_only").length;
  return { update, remote_only, local_only, total: update + remote_only + local_only };
}

/** Cap on how many rounds {@link expandConfigPullChangeSet} projects writes and re-diffs.
 *  Hitting the cap just stops absorbing further rounds rather than looping or throwing;
 *  `pull.handler.ts`'s schema-validation gate is the actual safety net. 4 rounds comfortably
 *  covers every dependency chain this registry has. */
export const CONFIG_PULL_FIXPOINT_ROUND_CAP = 4;

export interface ExpandConfigPullChangeSetInput {
  readonly initialChangeSet: ConfigChangeSet;
  /** The base `{config, document}` pair `diffProjectConfig` diffed to produce
   *  `initialChangeSet`; not destination-prefixed, since every round projects a write at its
   *  own `change.path`. */
  readonly baseConfig: EffectiveConfig;
  readonly baseDocument: Readonly<Record<string, unknown>>;
  readonly valueOrigins: ReadonlyArray<CliConfigValueOrigin> | undefined;
  readonly remote: ProjectConfig;
}

export interface ConfigPullFixpointResult {
  /** Every change observed across every round, in path order. A change that later converges
   *  still appears here with the values it carried at discovery, since the render/payload must
   *  report it as written. */
  readonly changeSet: ConfigChangeSet;
  /** The residual `diffProjectConfig` reported after the last round that projected a write —
   *  the state once every currently known write is applied. `pull.handler.ts`'s
   *  planner-defect/`unpushable` check consumes this. */
  readonly residual: ConfigChangeSet;
}

/**
 * Projects the current plan's writes onto the local `{config, document}` pair and re-diffs
 * against the same remote — this can surface new `update`/`remote_only` changes at paths that
 * were `unmanaged` before those writes landed (e.g. enabling a disabled SMS provider un-gates its
 * credential siblings). Repeats until a round projects nothing new (or
 * {@link CONFIG_PULL_FIXPOINT_ROUND_CAP} is hit). `planConfigPull` is called once, over the
 * merged `changeSet`, so a change appears exactly once rather than accumulating per round.
 */
export function expandConfigPullChangeSet(
  input: ExpandConfigPullChangeSetInput,
): ConfigPullFixpointResult {
  const seen = new Map<string, ConfigChange>();
  for (const change of input.initialChangeSet.changes) {
    seen.set(configPathKey(change.path), change);
  }

  let config: EffectiveConfig = input.baseConfig;
  let document: Record<string, unknown> = { ...input.baseDocument };
  let residual: ConfigChangeSet = input.initialChangeSet;
  const projectedPathKeys = new Set<string>();

  for (let round = 0; round < CONFIG_PULL_FIXPOINT_ROUND_CAP; round++) {
    const newlyWritable = [...seen.values()].filter(
      (change) => isWritableChange(change) && !projectedPathKeys.has(configPathKey(change.path)),
    );
    if (newlyWritable.length === 0) {
      break;
    }
    for (const change of newlyWritable) {
      config = configDeepSetAtPath(config, change.path, change.remote);
      document = configDeepSetAtPath(document, change.path, change.remote);
      projectedPathKeys.add(configPathKey(change.path));
    }
    residual = diffProjectConfig({
      local: { config, document, valueOrigins: input.valueOrigins },
      remote: input.remote,
    });
    for (const change of residual.changes) {
      const key = configPathKey(change.path);
      if (!seen.has(key)) {
        seen.set(key, change);
      }
    }
  }

  const changes = [...seen.values()].toSorted((a, b) => comparePaths(a.path, b.path));
  return {
    changeSet: {
      changes,
      masked: residual.masked,
      unmanaged: residual.unmanaged,
      counts: countsFor(changes),
      absencePolicy: residual.absencePolicy,
    },
    residual,
  };
}

/**
 * The nearest enclosing "family/provider table" of a failing config path — the unit
 * `pull.handler.ts`'s schema-validation gate drops together. Walks upward from `path`'s parent
 * for the deepest ancestor that is a record declaring an `enabled` key (every gated family this
 * registry has is exactly such a container), falling back to the immediate parent (or `path`
 * itself) when nothing matches.
 */
export function configPullFamilyRootForPath(
  path: ReadonlyArray<string>,
  document: unknown,
): ReadonlyArray<string> {
  for (let length = path.length - 1; length >= 1; length--) {
    const candidate = path.slice(0, length);
    const value = configValueAtPath(document, candidate);
    if (configIsRecord(value) && Object.hasOwn(value, "enabled")) {
      return candidate;
    }
  }
  return path.length <= 1 ? path : path.slice(0, -1);
}

/**
 * When the original (pre-pull) value at `path` is spelled as an unresolved `env(VAR)` literal,
 * returns `VAR` — feeds the `would_invalidate` note's "set VAR and rerun" remediation.
 * `document` must be in the same (raw, pre-write) namespace as `path`.
 */
export function configPullEnvVariableAtPath(
  path: ReadonlyArray<string>,
  document: unknown,
): string | undefined {
  const value = configValueAtPath(document, path);
  if (typeof value !== "string") {
    return undefined;
  }
  return ENV_CAPTURE_REGEX.exec(value)?.[1];
}

export interface ConfigPullWouldInvalidateFamily {
  readonly root: ReadonlyArray<string>;
  readonly missingFields: ReadonlyArray<ConfigPullMissingField>;
}

/** Whether `path` falls at or under `root` — shared by the write-drop and warning-drop passes
 *  below. Both sides live in the same `ConfigChange.path` namespace (never
 *  `remotes.<label>`-prefixed), so no destination-aware prefixing is needed here. */
function isUnderFamilyRoot(root: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return root.length <= path.length && root.every((segment, index) => segment === path[index]);
}

/**
 * The write-side counterpart to `pull.handler.ts`'s schema-validation gate: given the families
 * still missing/invalid after projecting `plan`'s writes, moves every write under one of those
 * roots from `writes` to `skipped` (`would_invalidate`), drops every other path-scoped warning
 * under the same root (a warning describing a write that was just skipped would be wrong), and
 * appends one `would_invalidate` warning per family that actually had a write to drop — a family
 * with nothing to reduce contributes no warning, signaling the caller to stop retrying. Pure: the
 * caller owns re-validating the reduced plan.
 */
export function dropConfigPullUnvalidatableFamilies(
  plan: ConfigPullPlan,
  families: ReadonlyArray<ConfigPullWouldInvalidateFamily>,
): ConfigPullPlan {
  if (families.length === 0) {
    return plan;
  }
  const droppedByRoot = new Map<string, Array<ConfigPullPlannedWrite>>();
  const writes: Array<ConfigPullPlannedWrite> = [];
  for (const write of plan.writes) {
    const family = families.find((candidate) =>
      isUnderFamilyRoot(candidate.root, write.change.path),
    );
    if (family === undefined) {
      writes.push(write);
      continue;
    }
    const key = configPathKey(family.root);
    const bucket = droppedByRoot.get(key);
    if (bucket === undefined) {
      droppedByRoot.set(key, [write]);
    } else {
      bucket.push(write);
    }
  }
  if (droppedByRoot.size === 0) {
    return plan;
  }
  const skipped = [
    ...plan.skipped,
    ...[...droppedByRoot.values()]
      .flat()
      .map((write) => ({ change: write.change, reason: "would_invalidate" as const })),
  ];
  const droppedFamilies = families.filter((family) =>
    droppedByRoot.has(configPathKey(family.root)),
  );
  const survivingWarnings = plan.warnings.filter((warning) => {
    const path = warning.path;
    return (
      path === undefined || !droppedFamilies.some((family) => isUnderFamilyRoot(family.root, path))
    );
  });
  const warnings = [
    ...survivingWarnings,
    ...droppedFamilies.map((family) => ({
      kind: "would_invalidate" as const,
      path: family.root,
      missingFields: family.missingFields,
    })),
  ];
  return { ...plan, writes, skipped, warnings };
}
