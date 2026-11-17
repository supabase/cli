import { renderGlamourTable } from "../../output/glamour-table.ts";
import type { ApiRequestPreview } from "./api-command-request.ts";

const INDENT = "  ";
const ACRONYMS: ReadonlySet<string> = new Set(["id", "url", "fdw", "dns", "api", "sql"]);

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): boolean => value === null || typeof value !== "object";

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
};

/** Keeps a value on one line by escaping line breaks, tabs and other control characters. */
const singleLine = (text: string): string =>
  text.replace(
    // oxlint-disable-next-line no-control-regex -- escaping control characters is the purpose
    /[\u0000-\u001f\u007f]/gu,
    (char) => CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const compactJson = (value: unknown): string => singleLine(JSON.stringify(value) ?? "null");

/** `snake_case` becomes a sentence-case label; known acronyms stay upper-case. */
const humanize = (key: string): string =>
  singleLine(key)
    .split("_")
    .filter((word) => word !== "")
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    })
    .join(" ");

const scalarText = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value === "" ? "-" : singleLine(value);
  return singleLine(String(value));
};

const cellText = (value: unknown): string =>
  isScalar(value) || value === undefined ? scalarText(value) : compactJson(value);

const isObjectArray = (value: unknown): value is ReadonlyArray<JsonObject> =>
  Array.isArray(value) && value.length > 0 && value.every(isObject);

/** A table indented under its label; the table's own blank framing lines are dropped. */
const tableLines = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  indent: string,
): ReadonlyArray<string> =>
  renderGlamourTable(headers, rows)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `${indent}${line}`);

const objectTable = (
  items: ReadonlyArray<JsonObject>,
  columns: ReadonlyArray<string>,
  indent: string,
): ReadonlyArray<string> =>
  tableLines(
    columns.map((column) => humanize(column).toUpperCase()),
    items.map((item) => columns.map((column) => cellText(item[column]))),
    indent,
  );

const unionKeys = (items: ReadonlyArray<JsonObject>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  for (const item of items) for (const key of Object.keys(item)) seen.add(key);
  return [...seen];
};

/** The inline text of a value that fits on one line, or `undefined` when it needs its own block. */
const inlineText = (value: unknown): string | undefined => {
  if (isScalar(value) || value === undefined) return scalarText(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "-";
    if (value.every(isScalar)) return value.map(scalarText).join(", ");
    return isObjectArray(value) ? undefined : compactJson(value);
  }
  return isObject(value) && Object.keys(value).length > 0 ? undefined : "-";
};

const blockLines = (entries: ReadonlyArray<readonly [string, unknown]>, indent: string) => {
  const rows = entries.map(([key, value]) => ({
    label: humanize(key),
    value,
    inline: inlineText(value),
  }));
  const width = Math.max(
    0,
    ...rows.flatMap((row) => (row.inline === undefined ? [] : [row.label.length])),
  );
  const lines: Array<string> = [];
  for (const { label, value, inline } of rows) {
    if (inline !== undefined) {
      lines.push(`${indent}${label.padEnd(width)}${INDENT}${inline}`);
      continue;
    }
    lines.push(`${indent}${label}`);
    if (isObjectArray(value)) {
      lines.push(...objectTable(value, unionKeys(value), indent));
    } else if (isObject(value)) {
      lines.push(...blockLines(Object.entries(value), `${indent}${INDENT}`));
    }
  }
  return lines;
};

const isResource = (value: unknown): value is JsonObject & { readonly attributes: JsonObject } =>
  isObject(value) && typeof value["type"] === "string" && isObject(value["attributes"]);

const resourceEntries = (resource: JsonObject & { readonly attributes: JsonObject }) => {
  const id = resource["id"];
  return [
    ...(id === undefined || id === null ? [] : ([["id", id]] as const)),
    ...Object.entries(resource.attributes),
  ];
};

const resourceLines = (document: JsonObject): ReadonlyArray<string> | undefined => {
  const keys = Object.keys(document);
  const data = document["data"];
  if (keys.length !== 1 || keys[0] !== "data") return undefined;
  if (isResource(data)) {
    return [humanize(String(data["type"])), ...blockLines(resourceEntries(data), INDENT)];
  }
  if (Array.isArray(data) && data.length > 0 && data.every(isResource)) {
    const rows = data.map((resource) => Object.fromEntries(resourceEntries(resource)));
    const columns = unionKeys(rows).filter((column) =>
      rows.some((row) => isScalar(row[column]) && row[column] !== undefined),
    );
    return [humanize(String(data[0]?.["type"])), ...objectTable(rows, columns, "")];
  }
  return undefined;
};

/** Renders a decoded JSON response as the text a person reads; always ends with a newline. */
export const renderResponseText = (value: unknown): string => {
  if (isObject(value)) {
    const lines = resourceLines(value) ?? blockLines(Object.entries(value), "");
    return `${(lines.length === 0 ? ["-"] : lines).join("\n")}\n`;
  }
  if (isObjectArray(value)) {
    return `${objectTable(value, unionKeys(value), "").join("\n")}\n`;
  }
  return `${inlineText(value) ?? compactJson(value)}\n`;
};

const rawBlock = (title: string, values: Readonly<Record<string, unknown>>) => {
  const entries = Object.entries(values);
  if (entries.length === 0) return [];
  const width = Math.max(...entries.map(([key]) => key.length));
  return [
    title,
    ...entries.map(
      ([key, value]) => `${INDENT}${singleLine(key).padEnd(width)}${INDENT}${cellText(value)}`,
    ),
  ];
};

/** Renders the request a dry run would send: a summary line, query and headers, then the body. */
export const renderDryRunText = (preview: ApiRequestPreview): string => {
  const body =
    preview.body === null || preview.body === undefined
      ? []
      : [
          "Body",
          ...JSON.stringify(preview.body, null, 2)
            .split("\n")
            .map((line) => `${INDENT}${line}`),
        ];
  return `${[
    `Dry run: ${singleLine(preview.method)} ${singleLine(preview.path)}`,
    ...rawBlock("Query", preview.query),
    ...rawBlock("Headers", preview.headers),
    ...body,
  ].join("\n")}\n`;
};
