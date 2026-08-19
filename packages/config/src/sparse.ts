import { Schema } from "effect";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";

/**
 * Sparse config subtraction — see `docs/adr/0018-sparse-config-subtraction.md`.
 *
 * A sparse config is a partial overlay containing only the values that differ
 * from some baseline. In the primary case — subtracting the default config
 * ({@link omitDefaultValues}) — the result is itself a valid config document:
 * re-decoding refills exactly what was removed, so it denotes the same
 * effective config under the current schema's defaults. Subtracting any other
 * baseline (e.g. a remote block against the merged base config) yields an
 * overlay meaningful only relative to that baseline. Arrays are compared
 * wholesale (order-sensitive) and never subtracted element-wise, so a sparse
 * value is always either an entire array or an object subtree of kept leaves —
 * hence arrays survive `DeepPartial` unchanged below.
 */
type DeepPartial<T> =
  T extends ReadonlyArray<unknown>
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export type SparseProjectConfig = DeepPartial<ProjectConfig>;

/**
 * The root-scope fields shared by a full {@link ProjectConfig} and a decoded
 * `[remotes.*]` block (which has the same sections but no nested `remotes`).
 * Subtraction accepts this shape so a remote block can be subtracted against
 * the merged base config directly, as ADR 0018 prescribes, without a cast.
 */
export type BaseProjectConfig = Omit<ProjectConfig, "remotes">;

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

let defaultProjectConfig: ProjectConfig | undefined;

/**
 * The default config: a {@link ProjectConfig} in which every value carries its
 * schema-declared default. Derived by decoding `{}` through
 * {@link ProjectConfigSchema} — the schema's `default` annotations and decoding
 * defaults are the single source of truth, so there is no hand-maintained
 * defaults table to drift. Fields declared `optionalKey` without a default
 * (e.g. `project_id`, `api.external_url`) are absent.
 *
 * Memoized (and the memo shared with callers) rather than computed at module
 * load, so importing the package doesn't pay for a full schema decode. The
 * memo is deeply frozen before it is shared: it doubles as the module-wide
 * subtraction baseline, so a caller mutation would silently corrupt every
 * later {@link omitDefaultValues} result.
 */
export function getDefaultProjectConfig(): ProjectConfig {
  defaultProjectConfig ??= deepFreeze(decodeProjectConfig({}));
  return defaultProjectConfig;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defines `key` as an own data property. Record keys come from user config
 * files, and both smol-toml and `JSON.parse` produce an own `__proto__` key
 * (a valid function name or remote label) that a plain `target[key] = value`
 * assignment would feed to the legacy prototype setter, silently dropping the
 * entry — or, for object values, swapping the target's prototype.
 */
export function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isEqualValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!isEqualValue(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !isEqualValue(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return Object.is(left, right);
}

/**
 * The untyped subtraction walk: returns `value − baseline`, or `undefined`
 * when nothing survives. Values strictly deep-equal (order-sensitive) to the
 * baseline's are removed; objects recurse per key and are dropped once empty;
 * arrays are removed wholesale on equality, never subtracted element-wise. A
 * key with no counterpart in the baseline is kept verbatim — which is exactly
 * how `remotes` and other record entries pass through untouched when the
 * baseline is the default config. Symmetrically, a baseline-only key is
 * ignored by design: subtraction reports what `value` declares, and in
 * overlay semantics absence means *inherit*, so a missing key is not a
 * removal.
 *
 * Shared with `io.ts`, which subtracts *encoded* documents before writing
 * minimal config files; the typed entry points below operate on decoded
 * {@link ProjectConfig} values, the only shape where "equals the default" is
 * well-defined.
 */
export function subtractValue(value: unknown, baseline: unknown): unknown {
  if (baseline === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return isEqualValue(value, baseline) ? undefined : value;
  }

  if (isObject(value)) {
    const baselineObject = isObject(baseline) ? baseline : {};
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      const subtracted = subtractValue(
        child,
        Object.hasOwn(baselineObject, key) ? baselineObject[key] : undefined,
      );

      if (subtracted !== undefined) {
        setOwnProperty(result, key, subtracted);
      }
    }

    return Object.keys(result).length === 0 ? undefined : result;
  }

  return isEqualValue(value, baseline) ? undefined : value;
}

/**
 * Returns the sparse config `config − baseline`. Directional: a value equal to
 * the baseline's is removed even when it differs from the schema default, and
 * a value differing from the baseline's is kept even when it equals the schema
 * default. A `[remotes.*]` block — config overrides for a specific persistent
 * Supabase branch, bound to it by `project_id` — has the merged base config as
 * its correct baseline, never the default config; see ADR 0018 for why
 * subtracting a remote block against global defaults would silently change
 * what the branch resolves to.
 */
export function subtractProjectConfig(
  config: BaseProjectConfig,
  baseline: BaseProjectConfig,
): SparseProjectConfig;
// The implementation signature stays untyped because TypeScript cannot verify
// that a structural walk over `unknown` reconstructs a `DeepPartial` of its
// input; the overload above is the contract, pinned by the unit tests.
export function subtractProjectConfig(
  config: BaseProjectConfig,
  baseline: BaseProjectConfig,
): unknown {
  const result = subtractValue(config, baseline);
  return isObject(result) ? result : {};
}

/**
 * Returns the sparse config `config − default config`: only the values that
 * differ from their schema defaults, per {@link subtractProjectConfig}'s
 * semantics. The result is itself a valid config document — re-decoding
 * refills the removed defaults, yielding the same effective config. `remotes`
 * blocks (per-persistent-branch overrides) pass through untouched (the
 * default config has none), and undefaulted `optionalKey` fields always
 * survive when present.
 *
 * The result is sparse at the root scope only: record-keyed entries
 * (`functions.*`, `remotes.*`) survive whole, with every per-entry decoding
 * default materialized — decoding fills them in, and the default config's
 * empty records offer no per-entry baseline to subtract. This cancels out in
 * a diff (both sides carry the same materialized defaults), but a consumer
 * rendering the result directly must strip entry-level defaults itself. For a
 * remote block that is necessarily the consumer's job — its correct baseline
 * is the merged base config (ADR 0018); for function entries, `io.ts`'s
 * `stripFunctionRecordDefaults` is the encoded-path precedent.
 */
export function omitDefaultValues(config: BaseProjectConfig): SparseProjectConfig {
  return subtractProjectConfig(config, getDefaultProjectConfig());
}
