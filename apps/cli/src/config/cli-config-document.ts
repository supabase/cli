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
export const cloneDocument = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneDocument);
  if (isDocumentRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneDocument(item)]),
    );
  }
  return value;
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
