import { isObject } from "./lib/document-value.ts";
import { setOwnProperty } from "./lib/own-property.ts";

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
