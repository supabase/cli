import type { ExpectedType } from "./lib/env-core.ts";

/** A compact, serializable view of the config schema: expected leaf types, deferred-env fields and key order. */
export interface SchemaIndexNode {
  readonly t?: ExpectedType;
  readonly d?: true;
  readonly p?: ReadonlyArray<readonly [string, SchemaIndexNode]>;
  readonly a?: SchemaIndexNode;
  readonly e?: ReadonlyArray<SchemaIndexNode>;
  readonly i?: SchemaIndexNode;
  readonly u?: ReadonlyArray<SchemaIndexNode>;
}

/** Mirrors the Effect schema navigator: the first union branch whose descent succeeds wins. */
export function descendIndex(node: SchemaIndexNode, segment: string): SchemaIndexNode | null {
  if (node.p !== undefined || node.a !== undefined) {
    const property = node.p?.find(([name]) => name === segment);
    return property?.[1] ?? node.a ?? null;
  }
  if (node.e !== undefined || node.i !== undefined) {
    const index = Number.parseInt(segment, 10);
    if (Number.isInteger(index)) {
      if (index >= 0 && node.e !== undefined && index < node.e.length) {
        return node.e[index] ?? null;
      }
      return node.i ?? null;
    }
    return null;
  }
  for (const variant of node.u ?? []) {
    const next = descendIndex(variant, segment);
    if (next !== null) {
      return next;
    }
  }
  return null;
}

/** Reorders object keys to the schema's declaration order, the order decoding produces. */
export function orderByIndex(value: unknown, node: SchemaIndexNode | null): unknown {
  if (node === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => orderByIndex(item, descendIndex(node, String(index))));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  const declared = declaredOrder(node);
  const rank = (key: string): number => {
    const found = declared.indexOf(key);
    return found === -1 ? declared.length : found;
  };
  return Object.fromEntries(
    entries
      .map(([key, child], position) => ({ key, child, position }))
      .sort((left, right) => rank(left.key) - rank(right.key) || left.position - right.position)
      .map(({ key, child }) => [key, orderByIndex(child, descendIndex(node, key))]),
  );
}

function declaredOrder(node: SchemaIndexNode): ReadonlyArray<string> {
  if (node.p !== undefined) {
    return node.p.map(([name]) => name);
  }
  for (const variant of node.u ?? []) {
    const names = declaredOrder(variant);
    if (names.length > 0) {
      return names;
    }
  }
  return [];
}
