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
