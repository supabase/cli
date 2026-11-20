/**
 * TEMPORARY (D23): SQL that today's Studio image sends and Spark cannot run. Delete with
 * `Catalog.ts` once Studio sends intents for Spark projects instead of this SQL.
 */
import type { Row } from "./Description.ts";
import type { Model } from "./Catalog.ts";

const stripComments = (s: string): string =>
  s.replace(/--[^\n]*/gu, " ").replace(/\/\*[\s\S]*?\*\//gu, " ");

/** Studio's grant loops after a table change, and its `pg_stat_statements` probe; Spark runs no `DO`. */
export const isStudioDo = (statement: string): boolean => {
  const text = stripComments(statement).trim();
  if (/pg_stat_statements\.track/u.test(text)) return true;
  const body = /^do\s+\$(\w*)\$([\s\S]*)\$\1\$/iu.exec(text)?.[2];
  if (body === undefined || body === "") return false;
  return body
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "" && s !== "begin" && s !== "end")
    .every(
      (line) =>
        /^(begin\s+)?execute format\('(grant|revoke) /u.test(line) ||
        /^(begin\s+)?(grant|revoke) /u.test(line),
    );
};

/** Studio's `pg_temp` helpers (the row count estimate) are session objects, not schema changes. */
export const isStudioTempObject = (statement: string): boolean => {
  const text = stripComments(statement).trim().toLowerCase().replace(/\s+/gu, " ");
  return (
    /^create (or replace )?(temp |temporary )?(function|table|view) pg_temp\./u.test(text) ||
    /^create (temp|temporary) /u.test(text)
  );
};

const quoteLiteral = (s: string): string => `'${s.replace(/'/gu, "''")}'`;

const literal = (value: unknown, type: string | undefined): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && type?.endsWith("[]") === true)
    return quoteLiteral(
      `{${value
        .map((item: unknown) =>
          item === null
            ? "NULL"
            : `"${(typeof item === "string" ? item : JSON.stringify(item)).replace(/["\\]/gu, "\\$&")}"`,
        )
        .join(",")}}`,
    );
  if (typeof value === "string") return quoteLiteral(value);
  return quoteLiteral(JSON.stringify(value));
};

const unquoteLiteral = (s: string): string =>
  s.startsWith("'") ? s.slice(1, -1).replace(/''/gu, "'") : s;

const quoteIdent = (s: string): string =>
  /^[a-z_][a-z0-9_]*$/u.test(s) ? s : `"${s.replace(/"/gu, '""')}"`;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRows = (text: string): ReadonlyArray<Row> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isRow);
    return isRow(parsed) ? [parsed] : undefined;
  } catch {
    return undefined;
  }
};

const tableOf = (model: Model, name: string) => {
  const parts = name.split(".").map((part) => part.replace(/^"|"$/gu, ""));
  const [schema, table] = parts.length === 2 ? parts : ["public", parts[0]];
  return schema === undefined || table === undefined ? undefined : model.findTable(schema, table);
};

const columnsOf = (list: string): ReadonlyArray<string> =>
  list.split(",").map((column) => column.trim().replace(/^"|"$/gu, ""));

/**
 * The table editor writes through `json(b)_populate_record(set)`, which Spark lacks: the same insert
 * or update with literals instead.
 */
export const rewriteEditorWrite = (model: Model, sql: string): string | undefined => {
  const empty =
    /^\s*insert\s+into\s+([\w."]+)\s+select\s+from\s+jsonb?_populate_recordset\s*\(\s*null::[\w."]+\s*,\s*'((?:[^']|'')*)'\s*\)([\s\S]*)$/iu.exec(
      sql,
    );
  if (empty?.[1] !== undefined && empty[2] !== undefined) {
    // turso has no DEFAULT VALUES; one column set to DEFAULT is the same row.
    const first = tableOf(model, empty[1])?.columns[0]?.name;
    const count = parseRows(empty[2].replace(/''/gu, "'"))?.length ?? 0;
    if (first === undefined || count === 0) return undefined;
    const rows = Array.from({ length: count }, () => "(default)").join(", ");
    return `insert into ${empty[1]} (${quoteIdent(first)}) values ${rows}${(empty[3] ?? "").trim().replace(/^;$/u, "")}`;
  }
  const insert =
    /^\s*insert\s+into\s+([\w."]+)\s*\(([^)]*)\)\s*select\s+[^;]*?\s+from\s+jsonb?_populate_recordset\s*\(\s*null::[\w."]+\s*,\s*('(?:[^']|'')*')\s*\)([\s\S]*)$/iu.exec(
      sql,
    );
  if (insert?.[1] !== undefined && insert[2] !== undefined && insert[3] !== undefined) {
    const table = tableOf(model, insert[1]);
    const columns = columnsOf(insert[2]);
    const rows = parseRows(unquoteLiteral(insert[3])) ?? [];
    const type = (column: string) => table?.columns.find((c) => c.name === column)?.type;
    const values = rows
      .map((row) => `(${columns.map((c) => literal(row[c], type(c))).join(", ")})`)
      .join(", ");
    return `insert into ${insert[1]} (${insert[2]}) values ${values}${(insert[4] ?? "").trim().replace(/^;$/u, "")}`;
  }
  const update =
    /^\s*update\s+([\w."]+)\s+set\s*\(([^)]*)\)\s*=\s*\(\s*select\s+[^;]*?\s+from\s+jsonb?_populate_record\s*\(\s*null::[\w."]+\s*,\s*('(?:[^']|'')*')\s*\)\s*\)([\s\S]*)$/iu.exec(
      sql,
    );
  if (update?.[1] !== undefined && update[2] !== undefined && update[3] !== undefined) {
    const table = tableOf(model, update[1]);
    const columns = columnsOf(update[2]);
    const row = parseRows(unquoteLiteral(update[3]))?.[0] ?? {};
    const type = (column: string) => table?.columns.find((c) => c.name === column)?.type;
    return `update ${update[1]} set ${columns.map((c) => `${quoteIdent(c)} = ${literal(row[c], type(c))}`).join(", ")}${boolLiterals(model, update[4] ?? "")}`;
  }
  return undefined;
};

/** Spark stores booleans as 0/1: `col = 'true'`, the table editor's filter form, never matches. */
export const boolLiterals = (model: Model, sql: string): string => {
  const booleans = new Set(
    model.description.tables.flatMap((t) =>
      t.columns.filter((c) => c.type === "boolean").map((c) => c.name),
    ),
  );
  return sql.replace(
    /("?)(\w+)\1\s*(=|<>|!=)\s*'(true|false|t|f)'/giu,
    (all: string, _quote: string, column: string, operator: string, value: string) =>
      booleans.has(column) ? `${column} ${operator} ${/^t/iu.test(value) ? "true" : "false"}` : all,
  );
};
