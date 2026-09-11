/**
 * Generic config-path helpers shared by `config push`'s pure modules
 * (push.encoders.ts, push.plan.ts, push.secrets.ts) and its handler, so every module
 * compares/looks up paths the same way.
 */

import type { ProjectConfig } from "@supabase/config";

import { configIsRecord } from "../config.paths.ts";

export const isRecord = configIsRecord;

export function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!configIsRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function samePath(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export function isPrefixOf(prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

export function pathIn(
  path: ReadonlyArray<string>,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return paths.some((candidate) => samePath(candidate, path));
}

/**
 * A stable total order for config paths — segment-by-segment, then by
 * length. Path segments are display-joined elsewhere, but a sort key needs
 * no delimiter (and can't collide on one, since a segment may itself
 * contain a `.`).
 */
export function comparePaths(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
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
 * A container's own enabled state, read from the local (declared) projection only, never
 * `remote` — gating decides whether `config push` attempts to write a container's fields at all.
 * `undefined` means the state can't be determined; callers must never coerce that into `false`.
 */
export function containerEnabled(
  local: ProjectConfig,
  path: ReadonlyArray<string>,
): boolean | undefined {
  const container = valueAtPath(local, path);
  if (!configIsRecord(container)) {
    return undefined;
  }
  const enabled = container["enabled"];
  return typeof enabled === "boolean" ? enabled : undefined;
}
