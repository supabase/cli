import * as SmolToml from "smol-toml";
import { isPlainRecord } from "./config-edit.ts";

export const INDENT = "  ";

export interface ArrayDecor {
  readonly items: ReadonlyArray<{ readonly lead: Array<string>; readonly trail?: string }>;
  readonly tail: Array<string>;
}

export function toJsoncComment(raw: string): string {
  return `//${raw.trim().slice(1)}`.trimEnd();
}

export function unsupportedReason(value: unknown): string | undefined {
  if (value instanceof SmolToml.TomlDate) {
    return "TOML date and time values have no JSON equivalent. Quote the value as a string, then rerun";
  }
  if (typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) {
    return "integers beyond the safe range and inf/nan floats have no JSON equivalent";
  }
  if (Array.isArray(value)) {
    return value.map(unsupportedReason).find((reason) => reason !== undefined);
  }
  if (isPlainRecord(value)) {
    return Object.values(value)
      .map(unsupportedReason)
      .find((reason) => reason !== undefined);
  }
  return undefined;
}

export function isScalar(value: unknown): boolean {
  return !Array.isArray(value) && !isPlainRecord(value);
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function withComma(lines: Array<string>, comma: string): Array<string> {
  const last = lines.length - 1;
  return lines.map((line, index) => (index === last ? `${line}${comma}` : line));
}

export function indented(indent: string, lines: ReadonlyArray<string>): Array<string> {
  return lines.map((line) => (line === "" ? "" : `${indent}${line}`));
}

function renderDecoratedArray(
  value: ReadonlyArray<unknown>,
  indent: string,
  decor: ArrayDecor,
): Array<string> {
  const inner = `${indent}${INDENT}`;
  const items = value.flatMap((item, index) => {
    const entry = decor.items[index];
    const comma = index < value.length - 1 ? "," : "";
    const trail = entry?.trail === undefined ? "" : ` ${entry.trail}`;
    return [...indented(inner, entry?.lead ?? []), `${inner}${scalarText(item)}${comma}${trail}`];
  });
  return ["[", ...items, ...indented(inner, decor.tail), `${indent}]`];
}

export function renderValue(
  value: unknown,
  indent: string,
  spread: boolean,
  decor?: ArrayDecor,
): Array<string> {
  const inner = `${indent}${INDENT}`;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["[]"];
    }
    if (decor !== undefined) {
      return renderDecoratedArray(value, indent, decor);
    }
    if (!spread && value.every(isScalar)) {
      return [`[${value.map(scalarText).join(", ")}]`];
    }
    const items = value.flatMap((item: unknown, index) => {
      const [first = "", ...rest] = renderValue(item, inner, false);
      return withComma([`${inner}${first}`, ...rest], index < value.length - 1 ? "," : "");
    });
    return ["[", ...items, `${indent}]`];
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return ["{}"];
    }
    const items = keys.flatMap((key, index) => {
      const [first = "", ...rest] = renderValue(value[key], inner, false);
      return withComma(
        [`${inner}${JSON.stringify(key)}: ${first}`, ...rest],
        index < keys.length - 1 ? "," : "",
      );
    });
    return ["{", ...items, `${indent}}`];
  }
  return [scalarText(value)];
}

function inlineValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(inlineValue).join(", ")}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 0
      ? "{}"
      : `{ ${keys.map((key) => `${JSON.stringify(key)}: ${inlineValue(value[key])}`).join(", ")} }`;
  }
  return scalarText(value);
}

export function commentedKvLines(
  path: ReadonlyArray<string>,
  value: unknown,
  indent: string,
): Array<string> {
  const [name = "", ...rest] = path;
  if (rest.length > 0) {
    const nested = rest.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
    return [`${indent}${JSON.stringify(name)}: ${inlineValue(nested)}`];
  }
  const [head = "", ...tail] = renderValue(value, indent, false);
  return [`${indent}${JSON.stringify(name)}: ${head}`, ...tail];
}
