/**
 * Generic, dependency-free path/value helpers for the `config` family, so every module walks a
 * `ConfigChange.path` the same way.
 *
 * `@supabase/config`'s `config-edit.ts` and `push/push.paths.ts` each keep their own similar
 * helpers (different runtime dependencies and guards) — do not unify them with this file.
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

/**
 * Whether `path`'s last segment is an own key of its parent, true even when the value is
 * `undefined` — that's what distinguishes it from {@link configValueAtPath} returning `undefined`.
 */
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
 * Deep-copies `root`, replacing the value at `path`. Never used to produce bytes written to
 * disk — that's `applyConfigEdits`'s job. The typed overload preserves the input's own shape
 * since a deep-set only ever changes a leaf value; the implementation itself stays untyped.
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
