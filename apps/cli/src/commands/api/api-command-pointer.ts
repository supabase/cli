import { Predicate } from "effect";

const segmentsOf = (pointer: string): ReadonlyArray<string> =>
  pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

/** Reads the value at an RFC 6901 JSON pointer, or `undefined` when any step is missing. */
export const readPointer = (root: unknown, pointer: string): unknown => {
  let current: unknown = root;
  for (const segment of segmentsOf(pointer)) {
    if (!Predicate.isObject(current)) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Returns a copy of `root` with `value` written at the pointer, creating missing objects. */
export const writePointer = (root: unknown, pointer: string, value: unknown): unknown => {
  const write = (node: unknown, segments: ReadonlyArray<string>): unknown => {
    const [head, ...rest] = segments;
    if (head === undefined) return value;
    const record = isPlainRecord(node) ? node : {};
    return { ...record, [head]: write(record[head], rest) };
  };
  return write(root, segmentsOf(pointer));
};
