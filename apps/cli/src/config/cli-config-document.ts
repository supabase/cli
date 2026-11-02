import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Redacted } from "effect";

export const isDocumentRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a path of segments in a parsed config document, or `undefined`. */
export const getDocumentValue = (document: unknown, segments: ReadonlyArray<string>): unknown => {
  let current: unknown = document;
  for (const segment of segments) {
    if (!isDocumentRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
};

/** Defines an own data property so a `__proto__` segment never reaches the prototype setter. */
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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

/** Writes `value` at a path of segments, creating intermediate tables and replacing non-table values. */
export const setDocumentValue = (
  document: Record<string, unknown>,
  segments: ReadonlyArray<string>,
  value: unknown,
): void => {
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  let node = document;
  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (isDocumentRecord(existing)) {
      node = existing;
      continue;
    }
    const created: Record<string, unknown> = {};
    defineOwn(node, segment, created);
    node = created;
  }
  defineOwn(node, last, value);
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
  paths: Iterable<ReadonlyArray<string>>,
  declared: unknown,
): void => {
  for (const segments of paths) {
    const tables: Array<Record<string, unknown>> = [document];
    for (const segment of segments.slice(0, -1)) {
      const holder = tables.at(-1);
      const next = holder !== undefined && Object.hasOwn(holder, segment) ? holder[segment] : null;
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
      if (getDocumentValue(declared, segments.slice(0, depth)) !== undefined) break;
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
