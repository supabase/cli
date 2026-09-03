/**
 * Generic config-path helpers shared by `config push`'s pure modules
 * (push.encoders.ts, push.plan.ts, push.secrets.ts) and its handler. Kept in
 * one place so every module compares/looks up paths the same way — see the
 * architecture review's A4.
 */

import type { ProjectConfig } from "@supabase/config";

export function legacyIsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function legacyValueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!legacyIsRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function legacySamePath(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export function legacyIsPrefixOf(
  prefix: ReadonlyArray<string>,
  path: ReadonlyArray<string>,
): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

export function legacyPathIn(
  path: ReadonlyArray<string>,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return paths.some((candidate) => legacySamePath(candidate, path));
}

/**
 * A stable total order for config paths — segment-by-segment, then by
 * length. Path segments are display-joined elsewhere, but a sort key needs
 * no delimiter (and can't collide on one, since a segment may itself
 * contain a `.`).
 */
export function legacyComparePaths(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/**
 * A container's own enabled state, read from the LOCAL (declared) projection
 * only — never `remote`, since gating decides whether `config push` even
 * attempts to write a container's fields at all, independently of the
 * project's current state (mirrors `fromConfigDocument`'s own raw-presence
 * mask and disabled-sentinel pruning). `undefined` means the container's
 * enabled state cannot be determined — it is absent from `local`, or present
 * without a boolean `enabled` field — and callers must never coerce that
 * into `false`/`""`.
 */
export function legacyContainerEnabled(
  local: ProjectConfig,
  path: ReadonlyArray<string>,
): boolean | undefined {
  const container = legacyValueAtPath(local, path);
  if (!legacyIsRecord(container)) {
    return undefined;
  }
  const enabled = container["enabled"];
  return typeof enabled === "boolean" ? enabled : undefined;
}
