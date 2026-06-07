import { Option } from "effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseFieldPath = (path: string): ReadonlyArray<string> =>
  path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const readPath = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const writePath = (
  target: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): void => {
  let current = target;
  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
      continue;
    }
    const nested: Record<string, unknown> = {};
    current[segment] = nested;
    current = nested;
  }
};

export function parsePlatformFieldsSelection(raw: Option.Option<string>): ReadonlyArray<string> {
  if (Option.isNone(raw)) {
    return [];
  }

  return raw.value
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

export function projectPlatformFields(value: unknown, fields: ReadonlyArray<string>): unknown {
  if (fields.length === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => projectPlatformFields(item, fields));
  }

  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};

  for (const field of fields) {
    const path = parseFieldPath(field);
    if (path.length === 0) {
      continue;
    }
    const resolved = readPath(value, path);
    if (resolved !== undefined) {
      writePath(projected, path, resolved);
    }
  }

  return projected;
}

function renderScalar(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function renderLines(value: unknown, indent: number): Array<string> {
  const prefix = "  ".repeat(indent);

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [`${prefix}${renderScalar(value)}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[]`];
    }
    return value.flatMap((item) => {
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      ) {
        return [`${prefix}- ${renderScalar(item)}`];
      }
      const nested = renderLines(item, indent + 1);
      const [first, ...rest] = nested;
      return [`${prefix}- ${(first ?? "").trimStart()}`, ...rest];
    });
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${prefix}{}`];
    }
    return entries.flatMap(([key, entryValue]) => {
      if (
        entryValue === null ||
        typeof entryValue === "string" ||
        typeof entryValue === "number" ||
        typeof entryValue === "boolean"
      ) {
        return [`${prefix}${key}: ${renderScalar(entryValue)}`];
      }
      return [`${prefix}${key}:`, ...renderLines(entryValue, indent + 1)];
    });
  }

  return [`${prefix}${JSON.stringify(value, null, 2)}`];
}

export function renderPlatformValue(value: unknown): string {
  return renderLines(value, 0).join("\n");
}
