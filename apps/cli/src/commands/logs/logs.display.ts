import type { Schema } from "effect";
import { renderTablewriter } from "../../command-internal/tabular-output.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";

const clean = (text: string) => stripControlSequences(text).replaceAll("\t", "    ");

export function wrapLogsText(text: string, width: number): string {
  const limit = Math.max(2, Math.floor(width));
  return clean(text)
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let current = "";
      let used = 0;
      for (const token of line.match(/\S+\s*|\s+/gu) ?? []) {
        if (used > 0 && used + stringWidth(token) > limit) {
          lines.push(current);
          current = "";
          used = 0;
        }
        for (const character of token) {
          const size = stringWidth(character);
          if (used > 0 && used + size > limit) {
            lines.push(current);
            current = "";
            used = 0;
          }
          current += character;
          used += size;
        }
      }
      return [...lines, current].join("\n");
    })
    .join("\n");
}

const queryValue = (value: Schema.Json | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? clean(value) : JSON.stringify(value);

function renderFields(fields: ReadonlyArray<readonly [string, string]>, width: number): string {
  return fields
    .map(([label, value]) => {
      const heading = wrapLogsText(`${label}:`, width);
      const content = wrapLogsText(value, width - 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `${heading}\n${content}`;
    })
    .join("\n");
}

export function renderLogsRows(rows: ReadonlyArray<Schema.JsonObject>, width: number): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const nested = rows.some((row) =>
    Object.values(row).some((value) => value !== null && typeof value === "object"),
  );
  if (!nested && columns.every((column) => !clean(column).includes("\n"))) {
    const values = rows.map((row) => columns.map((column) => queryValue(row[column])));
    const widths = columns.map((column, index) =>
      Math.max(
        stringWidth(clean(column)),
        ...values.flatMap((row) => (row[index] ?? "").split("\n").map(stringWidth)),
      ),
    );
    if (widths.reduce((sum, size) => sum + size + 3, 1) <= width)
      return renderTablewriter(columns.map(clean), values, (value) => String(value));
  }
  return rows
    .map((row, index) => {
      const fields = Object.entries(row).map(([key, value]): readonly [string, string] => [
        clean(key),
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      ]);
      return `${wrapLogsText(`Row ${index + 1}`, width)}\n${renderFields(fields, width)}\n`;
    })
    .join("\n");
}

const sourceValue = (value: Schema.Json | undefined): string =>
  Array.isArray(value)
    ? value.map(String).join(", ") || "None"
    : value == null
      ? "None"
      : String(value);

export function renderLogsSources(
  rows: ReadonlyArray<Schema.JsonObject>,
  detail: boolean,
  width: number,
): string {
  if (detail) {
    return (
      rows
        .map((row) =>
          renderFields(
            Object.entries(row).map(([key, value]) => [
              key === "sql" ? "SQL" : key.charAt(0).toUpperCase() + key.slice(1),
              sourceValue(value),
            ]),
            width,
          ),
        )
        .join("\n\n") + "\n"
    );
  }
  const overview = rows.map((row): Schema.JsonObject => {
    const fields = { service: row["service"] ?? "", kinds: sourceValue(row["kinds"]) };
    return row["resource"] === undefined ? fields : { ...fields, resource: row["resource"] };
  });
  return `${renderLogsRows(overview, width)}\n${wrapLogsText("Use --service <service> for SQL and supported filters.", width)}\n`;
}
