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

import type { LegacyConfigPullDestination } from "./pull.scope.ts";

/**
 * `config pull`'s write plan: classifies every `ConfigChange` `config diff`'s
 * classifier already computed (CLI-2230/ADR-0022's convergence normalizer)
 * into a planned write (replace or insert) or a skip with a reason, and
 * derives the warnings a written value should carry. Pure and synchronous
 * (CLI-2064) — no Effect, no services, no filesystem: this module only
 * decides WHAT would change and WHERE (`documentPath`); applying it is
 * `applyConfigEdits`'s job (`@supabase/config/internal`), and running it is
 * `pull.handler.ts`'s. `diffProjectConfig` is a pure, synchronous import
 * (no Effect, no services) — {@link legacyExpandConfigPullChangeSet} below
 * calls it directly rather than taking it as an injected callback.
 *
 * Also owns the plan-level half of CLI-2064's fixpoint/validation fix (a live
 * dogfooding bug: pulling a value that GATES other declared-but-unpushable
 * siblings — e.g. flipping a disabled SMS provider's `enabled` on — used to
 * write only the toggle, leaving its now-required siblings at their stale
 * local values and bricking the next config load). {@link
 * legacyExpandConfigPullChangeSet} re-classifies after projecting each
 * round's writes so a newly-un-gated sibling is absorbed into the SAME plan
 * (`pull.handler.ts`'s job to run it); {@link
 * legacyDropConfigPullUnvalidatableFamilies} is the write-side counterpart to
 * `pull.handler.ts`'s post-plan schema-validation gate — when that gate finds
 * the projected document still doesn't decode, it drops every write under the
 * offending family here rather than write a file the CLI itself cannot load.
 */

export type LegacyConfigPullSkipReason =
  | "env_reference"
  | "local_only"
  | "remote_env_reference"
  | "unwritable"
  | "would_invalidate";

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
  | "uncommitted_changes"
  | "unpushable"
  | "would_invalidate";

/**
 * One field {@link legacyDropConfigPullUnvalidatableFamilies} found still
 * missing/invalid in `pull.handler.ts`'s schema-validation gate — carried on
 * a `would_invalidate` warning so its note can name what actually blocked the
 * family, not just the family itself.
 */
export interface LegacyConfigPullMissingField {
  readonly path: ReadonlyArray<string>;
  /**
   * Set when this field's LOCAL (pre-pull) spelling is an unresolved
   * `env(VAR)` reference — the exact variable name to surface in the note
   * ("set VAR and rerun").
   */
  readonly envVariable?: string;
}

export interface LegacyConfigPullWarning {
  readonly kind: LegacyConfigPullWarningKind;
  /**
   * Absent for `uncommitted_changes` — a repository-level warning, not a
   * per-path one, constructed by `pull.handler.ts`'s own git dirty check
   * (`§1.4`). Also absent from anything THIS module produces (the three
   * path-bearing kinds below); `unpushable` is likewise constructed by
   * `pull.handler.ts`, from its post-plan convergence check (plan §1.9,
   * ADR 0021 decision 4) — a planned write that the convergence check finds
   * reclassifies as `unmanaged` once applied, because the value just written
   * made itself invisible to the projection again. CLI-2314 retired the one
   * `DISABLED_SENTINEL_PRUNES`-family prune that could still reclassify a
   * value after writing it (`auth.oauth_server`'s old unconditional
   * removal) — see ADR 0021's CLI-2314 addendum — but a live trigger
   * remains via a different mechanism: `applyDisabledSentinels`'s
   * cross-section rule deletes `auth.rate_limit.email_sent` whenever
   * `auth.email.smtp.enabled` decodes explicitly `false`, on BOTH arms — the
   * API arm only spares it for a genuinely SPARSE response that omits
   * `smtp_host` entirely (an ordinary `smtp_host: ""` response still prunes
   * it there too). So a sparse remote reporting a real
   * `rate_limit_email_sent` while omitting `smtp_host`, pulled into a
   * document that never declares `[auth.email.smtp]`, re-masks the
   * just-written path on the residual check (`pull.integration.test.ts`
   * pins the exact construction). Retained as a structural safety net for
   * any other asymmetric/cross-path prune too, not dead code.
   * Always carries `path`. `would_invalidate` also carries
   * `path` — the nearest enclosing family/provider table
   * {@link legacyDropConfigPullUnvalidatableFamilies} dropped every write
   * under (e.g. `["auth","sms","twilio"]`), constructed by `pull.handler.ts`
   * from its post-plan schema-validation gate.
   */
  readonly path?: ReadonlyArray<string>;
  /** `would_invalidate` only — see {@link LegacyConfigPullMissingField}. */
  readonly missingFields?: ReadonlyArray<LegacyConfigPullMissingField>;
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

/**
 * True when `value` — or any element/leaf inside it — is itself spelled as an
 * unresolved `env(VAR)` reference. Guards the REMOTE value's own spelling,
 * distinct from `change.envVariables` (which flags the LOCAL declaration):
 * the loader interpolates `env(VAR)` against THIS machine's environment on
 * every subsequent load (`goViperCompat`'s lenient, unanchored-variable-name
 * `ENV_CAPTURE_REGEX`), so writing a remote-controlled `env(...)` string
 * verbatim would let the platform smuggle a request to read whatever this
 * machine's environment happens to hold at that variable name — `config
 * diff` would then render the resolved local secret, and `config push` would
 * send it back to the platform (accepted security finding). Recurses into
 * arrays and nested objects for defense in depth, even though a diff leaf is
 * scalar/array today, never nested. The regex is anchored (`^env\(...\)$`),
 * so a substring mention (`"see env(FOO) docs"`) does not match.
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
 * erased; the `unwritable` case arises for a remote value `applyConfigEdits`
 * cannot represent (`undefined`/`null`, or a shape outside `ConfigEditValue`)
 * — expected to be rare given the registry's mapped value domains, but never
 * assumed impossible; finally, a `remote_env_reference` change — the REMOTE
 * value itself (only ever checked once it's already representable) is
 * spelled as an unresolved `env(VAR)` reference — is never written either,
 * since the loader would interpolate it against the LOCAL environment on the
 * next load, turning a remote-controlled string into a local
 * secret-exfiltration channel ({@link containsRemoteEnvReference}).
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

/**
 * Deep-copies `root`, replacing the value at `path` — shared by the fixpoint
 * expansion below (projecting a round's writes onto `{config, document}`
 * before re-diffing) and `pull.handler.ts`'s schema-validation gate
 * (projecting the plan's writes onto the raw on-disk document shape before
 * decoding it). Never used to produce bytes written to disk — that is
 * `applyConfigEdits`'s job. The exported-shaped overload preserves the
 * input's own type (a deep-set never changes an object's shape, only a leaf
 * value); the implementation itself is intentionally untyped, mirroring
 * `@supabase/config`'s own split between a typed overload contract and a
 * structurally-unverifiable recursive implementation.
 */
export function deepSetAtPath<T>(root: T, path: ReadonlyArray<string>, value: unknown): T;
export function deepSetAtPath(root: unknown, path: ReadonlyArray<string>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  const rest = path.slice(1);
  const base: Record<string, unknown> = isPlainRecord(root) ? root : {};
  return { ...base, [head]: deepSetAtPath(base[head], rest, value) };
}

/**
 * Intentionally does NOT also check {@link containsRemoteEnvReference}: this
 * predicate only gates what gets PROJECTED onto the fixpoint's own internal
 * `config`/`document` simulation below, never what actually reaches disk —
 * `legacyPlanConfigPull`, called once by the caller over the fixpoint's
 * merged `changeSet`, is the sole gate for that, and every change observed
 * here (including a `remote_env_reference` one) still reaches it via `seen`.
 */
function isWritableChange(change: ConfigChange): boolean {
  return (
    change.class !== "local_only" &&
    !(change.envVariables !== undefined && change.envVariables.length > 0) &&
    isConfigEditValue(change.remote)
  );
}

/** Segment-wise path order, mirroring `@supabase/config`'s own `comparePaths`
 * (`config-diff.ts`) — kept local rather than exported from there, since this
 * is the only other place in the CLI that needs to re-sort a merged
 * `ConfigChange` list. */
function comparePaths(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index];
    const right = b[index];
    // Both are always defined here (`index < length`, `length` the shorter
    // array's own bound) — the `undefined` checks satisfy indexed-access
    // typing without an `as string` cast, never actually reachable.
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

/** Cap on how many rounds {@link legacyExpandConfigPullChangeSet} projects a
 * round's writes and re-diffs — die-free: hitting the cap just stops
 * absorbing further rounds rather than looping forever or throwing;
 * `pull.handler.ts`'s schema-validation gate is the actual safety net against
 * writing something invalid. 4 rounds comfortably covers every real
 * dependency chain this registry has (a toggle gating at most a handful of
 * sibling credential fields, none of which themselves gate further fields). */
export const LEGACY_CONFIG_PULL_FIXPOINT_ROUND_CAP = 4;

export interface LegacyExpandConfigPullChangeSetInput {
  readonly initialChangeSet: ConfigChangeSet;
  /** The BASE `{config, document}` pair `diffProjectConfig` diffed to produce
   * `initialChangeSet` (`loaded.config`/`loaded.document ?? {}` — NOT
   * destination-prefixed; every round projects a write at its OWN
   * `change.path`, the same namespace `diffProjectConfig` classifies in). */
  readonly baseConfig: EffectiveConfig;
  readonly baseDocument: Readonly<Record<string, unknown>>;
  readonly valueOrigins: ReadonlyArray<CliConfigValueOrigin> | undefined;
  readonly remote: ProjectConfig;
}

export interface LegacyConfigPullFixpointResult {
  /** Every change ever observed across every round, in path order — a change
   * that later converges (its own written value now matches remote) still
   * appears here with the local/remote values it carried at DISCOVERY, since
   * `pull.handler.ts`'s render/payload must still report it as written. */
  readonly changeSet: ConfigChangeSet;
  /**
   * The residual `diffProjectConfig` reported after the LAST round that
   * projected a write — i.e. the state once every currently-known write has
   * been applied. `pull.handler.ts`'s planner-defect/`unpushable` check
   * consumes this exactly as it consumed a single round's residual before
   * this fixpoint existed.
   */
  readonly residual: ConfigChangeSet;
}

/**
 * Plan §1.9's convergence check, generalized from one round to a fixpoint
 * (CLI-2064's live-bug fix): after planning, projecting the CURRENT plan's
 * writes onto the local `{config, document}` pair and re-diffing against the
 * SAME `remote` can surface brand new `update`/`remote_only` changes at paths
 * that were `unmanaged` (ADR 0021's disabled-provider gates) before those
 * writes landed — e.g. flipping a disabled SMS provider's `enabled` to `true`
 * un-gates its credential siblings. Repeats until a round projects nothing new
 * to write (or {@link LEGACY_CONFIG_PULL_FIXPOINT_ROUND_CAP} is hit), so a
 * newly un-gated sibling gets exactly the SAME skip rules as any other change
 * (`legacyPlanConfigPull`, called once by the caller over this function's
 * merged `changeSet` — never per round: warnings/skips must be derived from
 * the union, not accumulated round-by-round, so a change appears exactly
 * once).
 */
export function legacyExpandConfigPullChangeSet(
  input: LegacyExpandConfigPullChangeSetInput,
): LegacyConfigPullFixpointResult {
  const seen = new Map<string, ConfigChange>();
  for (const change of input.initialChangeSet.changes) {
    seen.set(pathKey(change.path), change);
  }

  let config: EffectiveConfig = input.baseConfig;
  let document: Record<string, unknown> = { ...input.baseDocument };
  let residual: ConfigChangeSet = input.initialChangeSet;
  const projectedPathKeys = new Set<string>();

  for (let round = 0; round < LEGACY_CONFIG_PULL_FIXPOINT_ROUND_CAP; round++) {
    const newlyWritable = [...seen.values()].filter(
      (change) => isWritableChange(change) && !projectedPathKeys.has(pathKey(change.path)),
    );
    if (newlyWritable.length === 0) {
      break;
    }
    for (const change of newlyWritable) {
      config = deepSetAtPath(config, change.path, change.remote);
      document = deepSetAtPath(document, change.path, change.remote);
      projectedPathKeys.add(pathKey(change.path));
    }
    residual = diffProjectConfig({
      local: { config, document, valueOrigins: input.valueOrigins },
      remote: input.remote,
    });
    for (const change of residual.changes) {
      const key = pathKey(change.path);
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
 * The nearest enclosing "family/provider table" of a failing config path —
 * `pull.handler.ts`'s schema-validation gate's own idea of the unit to drop
 * together (plan of record: "drop every planned write under the nearest
 * enclosing provider/family table"). Walks upward from `path`'s immediate
 * parent looking for the deepest ancestor whose value (read off `document`,
 * the same shape the failing decode saw) is a record declaring an `enabled`
 * key — every gated family this registry has (SMS providers, SMTP, external
 * providers, hooks, oauth_server, …) is exactly such a container. Falls back
 * to `path`'s immediate parent when no ancestor matches (or `path` itself
 * when it has no parent), so a family this heuristic doesn't recognize still
 * drops at least the failing field's own container rather than nothing.
 */
export function legacyConfigPullFamilyRootForPath(
  path: ReadonlyArray<string>,
  document: unknown,
): ReadonlyArray<string> {
  for (let length = path.length - 1; length >= 1; length--) {
    const candidate = path.slice(0, length);
    const value = valueAtPath(document, candidate);
    if (isPlainRecord(value) && Object.hasOwn(value, "enabled")) {
      return candidate;
    }
  }
  return path.length <= 1 ? path : path.slice(0, -1);
}

/**
 * When the ORIGINAL (pre-pull) value at `path` is spelled as an unresolved
 * `env(VAR)` literal, returns `VAR` — feeds the `would_invalidate` note's
 * "set VAR and rerun" remediation. `document` must be in the same (raw,
 * pre-write) namespace as `path`.
 */
export function legacyConfigPullEnvVariableAtPath(
  path: ReadonlyArray<string>,
  document: unknown,
): string | undefined {
  const value = valueAtPath(document, path);
  if (typeof value !== "string") {
    return undefined;
  }
  return ENV_CAPTURE_REGEX.exec(value)?.[1];
}

export interface LegacyConfigPullWouldInvalidateFamily {
  readonly root: ReadonlyArray<string>;
  readonly missingFields: ReadonlyArray<LegacyConfigPullMissingField>;
}

/** Whether `path` falls at or under `root` — the "belongs to this family"
 * test shared by the write-drop and warning-drop passes below. Both sides of
 * the comparison live in the SAME `ConfigChange.path` namespace (never
 * `remotes.<label>`-prefixed, regardless of destination — see
 * `pull.handler.ts`'s own family-root computation), so no destination-aware
 * prefixing is needed here either. */
function isUnderFamilyRoot(root: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return root.length <= path.length && root.every((segment, index) => segment === path[index]);
}

/**
 * `pull.handler.ts`'s schema-validation gate's write-side counterpart: given
 * the families it found still missing/invalid after projecting `plan`'s
 * writes, moves every write whose path falls under one of those families'
 * roots from `writes` to `skipped` (reason `would_invalidate`), drops every
 * OTHER path-scoped warning (`dual_scope`/`duplicates_root`/`array_drift`
 * from this module, `unpushable` from `pull.handler.ts`'s own convergence
 * check) that falls under the same root — a warning surviving for a write
 * that was just moved back to `skipped` would describe something that was
 * never actually written (`unpushable`'s own wording literally says "was
 * written here") — and only THEN appends one `would_invalidate` warning per
 * family that actually had a write to drop (a family the caller flagged but
 * which planned no write for — nothing left to reduce — contributes no
 * warning; the caller treats that as "could not make progress" and stops
 * retrying instead of looping on a no-op drop). Pure: the caller owns
 * re-validating the reduced plan.
 */
export function legacyDropConfigPullUnvalidatableFamilies(
  plan: LegacyConfigPullPlan,
  families: ReadonlyArray<LegacyConfigPullWouldInvalidateFamily>,
): LegacyConfigPullPlan {
  if (families.length === 0) {
    return plan;
  }
  const droppedByRoot = new Map<string, Array<LegacyConfigPullPlannedWrite>>();
  const writes: Array<LegacyConfigPullPlannedWrite> = [];
  for (const write of plan.writes) {
    const family = families.find((candidate) =>
      isUnderFamilyRoot(candidate.root, write.change.path),
    );
    if (family === undefined) {
      writes.push(write);
      continue;
    }
    const key = pathKey(family.root);
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
  const droppedFamilies = families.filter((family) => droppedByRoot.has(pathKey(family.root)));
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
