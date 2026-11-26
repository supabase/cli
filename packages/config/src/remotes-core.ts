import { isObject } from "./lib/document-value.ts";
import { setOwnProperty } from "./lib/own-property.ts";

/**
 * Deep-merges a `[remotes.*]` subtree over the base document: nested objects merge recursively,
 * arrays and scalars replace wholesale. Operates on the raw, pre-decode document so only keys
 * the remote block actually declares override the base — the remote section's schema defaults
 * never leak in.
 */
function mergeRemoteSubtree(
  base: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(remote)) {
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    setOwnProperty(
      result,
      key,
      isObject(existing) && isObject(value) ? mergeRemoteSubtree(existing, value) : value,
    );
  }
  return result;
}

/** Whether a remote subtree explicitly declares `db.seed.enabled`. */
function remoteSetsDbSeedEnabled(remote: Record<string, unknown>): boolean {
  const db = remote["db"];
  const seed = isObject(db) ? db["seed"] : undefined;
  return isObject(seed) && "enabled" in seed;
}

/** Forces `db.seed.enabled = false`, immutably. */
function withDbSeedDisabled(document: Record<string, unknown>): Record<string, unknown> {
  const db = isObject(document["db"]) ? document["db"] : {};
  const seed = isObject(db["seed"]) ? db["seed"] : {};
  return { ...document, db: { ...db, seed: { ...seed, enabled: false } } };
}

export function collectLeafPaths(
  value: unknown,
  prefix: ReadonlyArray<string> = [],
): Array<string[]> {
  if (!isObject(value)) {
    return [Array.from(prefix)];
  }

  return Object.entries(value).flatMap(([key, child]) => collectLeafPaths(child, [...prefix, key]));
}

export function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/**
 * Extracts `project_id` for every `[remotes.<name>]` block, in document order, reading a
 * missing field as `""`. Returns `[]` for anything that isn't a `remotes` table.
 */
export function remoteProjectIdEntries(
  remotes: unknown,
): ReadonlyArray<{ readonly name: string; readonly projectId: string }> {
  if (!isObject(remotes)) {
    return [];
  }
  return Object.entries(remotes).map(([name, remote]) => ({
    name,
    projectId:
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "",
  }));
}

/**
 * The name of the `[remotes.<name>]` block whose `project_id` equals `projectRef`, or
 * `undefined` when none matches (including when `projectRef` itself is `undefined`). Matches
 * against the raw, pre-`env()` literal — callers must pass `LoadedCliConfig.rawDocument`'s
 * `remotes`, never `LoadedCliConfig.document`, so a `project_id = "env(REF)"` that resolves to
 * `REF` doesn't match a caller-supplied, already-resolved `REF`.
 */
export function remoteNameForProjectRef(
  remotes: unknown,
  projectRef: string | undefined,
): string | undefined {
  if (projectRef === undefined) {
    return undefined;
  }
  return remoteProjectIdEntries(remotes).find((entry) => entry.projectId === projectRef)?.name;
}

/** Valid project ref format: exactly 20 lowercase ASCII letters. */
const REMOTE_PROJECT_ID_PATTERN = /^[a-z]{20}$/;

export function duplicateRemoteProjectIdMessage(
  remotes: Record<string, unknown>,
): string | undefined {
  const idToName = new Map<string, string>();
  for (const { name, projectId } of remoteProjectIdEntries(remotes)) {
    const other = idToName.get(projectId);
    if (other !== undefined) {
      return `duplicate project_id for [remotes.${name}] and ${other}`;
    }
    idToName.set(projectId, `[remotes.${name}]`);
  }
  return undefined;
}

export function invalidRemoteProjectIdMessage(
  remotes: Record<string, unknown>,
): string | undefined {
  for (const { name, projectId } of remoteProjectIdEntries(remotes)) {
    if (!REMOTE_PROJECT_ID_PATTERN.test(projectId)) {
      return `Invalid config for remotes.${name}.project_id. Must be like: abcdefghijklmnopqrst`;
    }
  }
  return undefined;
}

/** Name of the `[remotes.*]` block to merge: the selector's pick when given, else the one matching `projectRef`. */
export function selectRemoteName(
  remotes: Record<string, unknown>,
  projectRef: string | undefined,
  selectRemote?: (remotes: Record<string, unknown>) => string | undefined,
): string | undefined {
  if (selectRemote === undefined) {
    return remoteNameForProjectRef(remotes, projectRef);
  }
  const selected = selectRemote(remotes);
  return selected !== undefined && Object.hasOwn(remotes, selected) ? selected : undefined;
}

/** Merges `remotes[name]` over `document`, disabling `db.seed` unless the remote sets it, and drops `remotes`. */
export function mergeRemoteBlock(
  document: Record<string, unknown>,
  remoteSubtree: unknown,
): Record<string, unknown> {
  let merged = isObject(remoteSubtree)
    ? mergeRemoteSubtree(document, remoteSubtree)
    : { ...document };
  if (!(isObject(remoteSubtree) && remoteSetsDbSeedEnabled(remoteSubtree))) {
    merged = withDbSeedDisabled(merged);
  }
  delete merged["remotes"];
  return merged;
}
