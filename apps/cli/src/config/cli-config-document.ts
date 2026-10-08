import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Redacted } from "effect";

export const isDocumentRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a dotted path of a parsed config document, or `undefined`. */
export const getDocumentValue = (document: unknown, path: string): unknown => {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (!isDocumentRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
};

/** Whether two document values are the same plain scalars, arrays or tables. */
export const sameDocumentValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** A deep copy of the plain-object and array structure of a parsed document. */
const cloneDocument = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneDocument);
  if (isDocumentRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneDocument(item)]),
    );
  }
  return value;
};

/** {@link cloneDocument} for a table; anything else clones to an empty table. */
export const cloneDocumentRecord = (value: unknown): Record<string, unknown> => {
  const copy = cloneDocument(value);
  return isDocumentRecord(copy) ? copy : {};
};

/** Writes `value` at a dotted path, creating intermediate tables and replacing non-table values. */
export const setDocumentValue = (
  document: Record<string, unknown>,
  path: string,
  value: unknown,
): void => {
  const segments = path.split(".");
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  let node = document;
  for (const segment of segments.slice(0, -1)) {
    const existing = node[segment];
    if (isDocumentRecord(existing)) {
      node = existing;
      continue;
    }
    const created: Record<string, unknown> = {};
    node[segment] = created;
    node = created;
  }
  node[last] = value;
};

/** Every leaf path of a document (arrays and scalars are leaves), dotted. */
export const documentLeafPaths = (
  value: unknown,
  prefix: ReadonlyArray<string> = [],
): Set<string> => {
  const out = new Set<string>();
  const visit = (node: unknown, path: ReadonlyArray<string>) => {
    if (isDocumentRecord(node)) {
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
      return;
    }
    out.add(path.join("."));
  };
  visit(value, prefix);
  return out;
};

/** Removes the leaves at `paths`, then each table they emptied unless `declared` also holds it. */
export const pruneDocumentPaths = (
  document: Record<string, unknown>,
  paths: Iterable<string>,
  declared: unknown,
): void => {
  for (const path of paths) {
    const segments = path.split(".");
    const tables: Array<Record<string, unknown>> = [document];
    for (const segment of segments.slice(0, -1)) {
      const next = tables.at(-1)?.[segment];
      if (!isDocumentRecord(next)) break;
      tables.push(next);
    }
    const leaf = segments.at(-1);
    const holder = tables.at(-1);
    if (tables.length !== segments.length || leaf === undefined || holder === undefined) continue;
    delete holder[leaf];
    for (let depth = tables.length - 1; depth > 0; depth--) {
      const table = tables[depth];
      const parent = tables[depth - 1];
      const key = segments[depth - 1];
      if (table === undefined || parent === undefined || key === undefined) break;
      if (Object.keys(table).length > 0) break;
      if (getDocumentValue(declared, segments.slice(0, depth).join(".")) !== undefined) break;
      delete parent[key];
    }
  }
};

/** Adds the name of every whole-value `env(NAME)` string in `value`, including inside `Redacted`. */
export const collectEnvReferences = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
    if (name !== undefined) out.add(name);
  } else if (Redacted.isRedacted(value)) {
    collectEnvReferences(Redacted.value(value), out);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, out);
  } else if (isDocumentRecord(value)) {
    for (const item of Object.values(value)) collectEnvReferences(item, out);
  }
};

/** The names every whole-value `env(NAME)` string in `trees` refers to. */
export const envReferenceNames = (...trees: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const names = new Set<string>();
  collectEnvReferences(trees, names);
  return names;
};
