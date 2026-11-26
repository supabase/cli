import { Schema } from "effect";
import { CliConfigSchema, type CliConfig } from "./base.ts";
import { isObject } from "./lib/document-value.ts";
import { deepFreeze, subtractValue } from "./sparse-core.ts";

export { deepFreeze };

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

// A path segment must match the key exactly in both directions, so a `string` index signature
// never absorbs a literal segment meant for one named key.
type ChildPaths<Paths, K extends PropertyKey> = Paths extends readonly [infer Head, ...infer Rest]
  ? Head extends K
    ? K extends Head
      ? Rest
      : never
    : never
  : never;

type IsPlainObject<T> = T extends ReadonlyArray<unknown> ? false : T extends object ? true : false;

// True when `T` had keys but its `OmitPaths` result has none, so the emptied container is dropped
// along with its last member rather than surviving as `{}`.
type IsEmptiedBy<T, Paths extends ReadonlyArray<string>> =
  IsPlainObject<T> extends true
    ? [keyof T] extends [never]
      ? false
      : [keyof OmitPaths<T, Paths>] extends [never]
        ? true
        : false
    : false;

/** `T` with every property addressed by a tuple in the `Paths` union removed, at any depth; arrays are left whole and a container emptied by the removal is removed too. */
export type OmitPaths<T, Paths extends ReadonlyArray<string>> = [Paths] extends [never]
  ? T
  : T extends ReadonlyArray<unknown>
    ? T
    : T extends object
      ? {
          [
            K in keyof T as [] extends ChildPaths<Paths, K>
              ? never
              : IsEmptiedBy<T[K], ChildPaths<Paths, K>> extends true
                ? never
                : K
          ]: OmitPaths<T[K], ChildPaths<Paths, K>>;
        }
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
