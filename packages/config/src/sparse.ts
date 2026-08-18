import { Schema } from "effect";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";

/**
 * Sparse config subtraction — see `docs/adr/0017-sparse-config-subtraction.md`.
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
 * load, so importing the package doesn't pay for a full schema decode; the
 * decoded config is deeply readonly by type, so sharing is safe.
 */
export function getDefaultProjectConfig(): ProjectConfig {
  defaultProjectConfig ??= decodeProjectConfig({});
  return defaultProjectConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      if (!(key in right) || !isEqualValue(left[key], right[key])) {
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
 * baseline is the default config.
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
      const subtracted = subtractValue(child, baselineObject[key]);

      if (subtracted !== undefined) {
        result[key] = subtracted;
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
 * its correct baseline, never the default config; see ADR 0017 for why
 * subtracting a remote block against global defaults would silently change
 * what the branch resolves to.
 */
export function subtractProjectConfig(
  config: ProjectConfig,
  baseline: ProjectConfig,
): SparseProjectConfig;
// The implementation signature stays untyped because TypeScript cannot verify
// that a structural walk over `unknown` reconstructs a `DeepPartial` of its
// input; the overload above is the contract, pinned by the unit tests.
export function subtractProjectConfig(config: ProjectConfig, baseline: ProjectConfig): unknown {
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
 */
export function omitDefaultValues(config: ProjectConfig): SparseProjectConfig {
  return subtractProjectConfig(config, getDefaultProjectConfig());
}
