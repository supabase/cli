import { Schema } from "effect";
import { CliConfigSchema, type CliConfig } from "./base.ts";

/**
 * A deeply partial `T` used for sparse config overlays; arrays are kept as whole units
 * rather than partialized element-wise. See `docs/adr/0018-sparse-config-subtraction.md`.
 */
export type DeepPartial<T> =
  T extends ReadonlyArray<unknown>
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export type SparseCliConfig = DeepPartial<CliConfig>;

/**
 * The comparison operand shape: a deeply partial {@link CliConfig} without `remotes`.
 * Every key an operand carries must hold its fully-resolved effective value; an absent key
 * means the operand doesn't speak for that field, not that the field is at its default.
 */
export type EffectiveConfig = DeepPartial<Omit<CliConfig, "remotes">>;

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

let defaultCliConfig: CliConfig | undefined;

/**
 * The default config: a {@link CliConfig} decoded from `{}`, so every value carries its
 * schema-declared default. Memoized and deeply frozen; the frozen result is reused as the
 * baseline for every {@link omitDefaultValues} call, so callers must not mutate it.
 */
export function getDefaultCliConfig(): CliConfig {
  defaultCliConfig ??= deepFreeze(decodeCliConfig({}));
  return defaultCliConfig;
}

/**
 * Recursively freezes `value` and returns it. Guards against revisiting an already-seen
 * object with a `WeakSet`, so it stays safe to call against cyclic or untrusted input.
 */
export function deepFreeze<T>(value: T): T {
  return deepFreezeVisiting(value, new WeakSet());
}

function deepFreezeVisiting<T>(value: T, visited: WeakSet<object>): T {
  if (typeof value === "object" && value !== null) {
    if (visited.has(value)) {
      return value;
    }
    visited.add(value);
    for (const child of Object.values(value)) {
      deepFreezeVisiting(child, visited);
    }
    Object.freeze(value);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defines `key` as an own data property. Guards against a `__proto__` key from user config
 * (a valid function name or remote label) being treated as the prototype setter by a plain
 * assignment, which would silently drop the entry or swap the target's prototype.
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
 * Returns `value − baseline`, or `undefined` when nothing survives. A key missing from the
 * baseline is kept verbatim (so record entries like `remotes` pass through untouched); a
 * key present only in the baseline is ignored, since overlay absence means "inherit".
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
 * Returns the sparse config `config − baseline`. Directional: a value equal to the
 * baseline is removed even if it differs from the schema default, and kept otherwise.
 *
 * Both operands must be effective — every present key holds its fully-resolved value. A
 * standalone-decoded `[remotes.*]` block does not qualify: decoding it alone materializes
 * defaults it meant to inherit from the base config. See
 * `docs/adr/0018-sparse-config-subtraction.md`.
 */
export function subtractCliConfig(
  config: EffectiveConfig,
  baseline: EffectiveConfig,
): SparseCliConfig;
// Untyped here because a structural walk over `unknown` can't be verified to reconstruct a
// `DeepPartial`; the overload above is the enforced contract.
export function subtractCliConfig(config: EffectiveConfig, baseline: EffectiveConfig): unknown {
  const result = subtractValue(config, baseline);
  return isObject(result) ? result : {};
}

/**
 * Returns the sparse config `config − default config`: only the values differing from
 * their schema defaults. The result re-decodes to the same effective config.
 *
 * Sparse only at the root: record-keyed entries (`functions.*`, `remotes.*`) survive
 * whole, with their own per-entry defaults materialized, so a consumer rendering the
 * result directly must strip those defaults itself.
 */
export function omitDefaultValues(config: EffectiveConfig): SparseCliConfig {
  return subtractCliConfig(config, getDefaultCliConfig());
}
