/**
 * Generic path/value helpers for the `config` command family — read a value at a path,
 * test whether a path is DECLARED, compare two values structurally, key a path for a
 * Set/Map, and deep-copy-with-replacement at a path. Pure, synchronous, dependency-free
 * (no Effect, no services, no imports at all), so every module in the family that walks a
 * `ConfigChange.path` walks it the same way.
 *
 * Two deliberate non-consolidations:
 *
 *  - `@supabase/config`'s `config-edit.ts` keeps its OWN copies of `isPlainRecord`,
 *    `pathKey`, `valueAtPath`, `isDeclaredAtPath`, and `deepEqualValue`. That module is
 *    pinned to `smol-toml` as its only runtime import (ADR 0023) so it stays independently
 *    embeddable, and its `deepEqualValue` additionally special-cases `SmolToml.TomlDate`
 *    because it compares raw `smol-toml` parse trees. Never make it import this file, and
 *    never "unify" the two.
 *  - `push/push.paths.ts` keeps its own `valueAtPath`: that one deliberately omits
 *    this file's `Object.hasOwn` guard, so the two are not interchangeable.
 */

export function configPathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

export function configIsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configValueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!configIsRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Whether `path`'s LAST segment is an own key of its parent — true even when the declared
 *  value is `undefined`, which is exactly what distinguishes it from
 *  {@link configValueAtPath} returning `undefined`. */
export function configIsDeclaredAtPath(root: unknown, path: ReadonlyArray<string>): boolean {
  let current: unknown = root;
  for (const [index, segment] of path.entries()) {
    if (!configIsRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    if (index < path.length - 1) {
      current = current[segment];
    }
  }
  return true;
}

export function configDeepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((value, index) => configDeepEqualValue(value, b[index]))
    );
  }
  if (configIsRecord(a) && configIsRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && configDeepEqualValue(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Deep-copies `root`, replacing the value at `path`. Two consumers today: `pull.plan.ts`'s
 * fixpoint expansion (projecting a round's writes onto `{config, document}` before
 * re-diffing) and `pull.handler.ts`'s schema-validation gate (projecting the plan's writes
 * onto the raw on-disk document shape before decoding it). Never used to produce bytes
 * written to disk — that is `applyConfigEdits`'s job. The exported-shaped overload preserves
 * the input's own type (a deep-set never changes an object's shape, only a leaf value); the
 * implementation itself is intentionally untyped, mirroring `@supabase/config`'s own split
 * between a typed overload contract and a structurally-unverifiable recursive implementation.
 */
export function configDeepSetAtPath<T>(root: T, path: ReadonlyArray<string>, value: unknown): T;
export function configDeepSetAtPath(
  root: unknown,
  path: ReadonlyArray<string>,
  value: unknown,
): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  const rest = path.slice(1);
  const base: Record<string, unknown> = configIsRecord(root) ? root : {};
  return { ...base, [head]: configDeepSetAtPath(base[head], rest, value) };
}
