import type { Row } from "./Description.ts";
import { type Model, typeInfo } from "./Catalog.ts";

/** Splits on top-level `;`, honoring quotes, dollar quotes and comments. */
export const splitSql = (sql: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  let current = "";
  let i = 0;
  const push = () => {
    if (stripComments(current).trim() !== "") out.push(current.trim());
    current = "";
  };
  while (i < sql.length) {
    const c = sql[i] ?? "";
    const two = sql.slice(i, i + 2);
    let stop = i + 1;
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      stop = end === -1 ? sql.length : end;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      stop = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      stop = j + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/u.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length);
        stop = end === -1 ? sql.length : end + tag.length;
      }
    } else if (c === ";") {
      push();
      i++;
      continue;
    }
    current += sql.slice(i, stop);
    i = stop;
  }
  push();
  return out;
};

export const stripComments = (s: string): string =>
  s.replace(/--[^\n]*/gu, " ").replace(/\/\*[\s\S]*?\*\//gu, " ");

export const words = (s: string): ReadonlyArray<string> =>
  stripComments(s).trim().toLowerCase().split(/\s+/u);

const firstWord = (s: string): string => words(s)[0] ?? "";

const DDL = new Set(["create", "alter", "drop", "comment", "grant", "revoke", "security"]);

/** Session-local objects, such as Studio's `pg_temp` helpers, are not schema changes. */
const isTempObject = (statement: string): boolean => {
  const text = words(statement).join(" ");
  return (
    /^create (or replace )?(temp|temporary )?\s*(function|table|view)?\s*pg_temp\./u.test(text) ||
    /^create (temp|temporary) /u.test(text)
  );
};

export const isDdl = (statement: string): boolean =>
  DDL.has(firstWord(statement)) && !isTempObject(statement);

/** A `DO` block that only grants or revokes; grants are no-ops on Spark, where RLS is the access control. */
export const isGrantDo = (statement: string): boolean => {
  const body = /^do\s+\$(\w*)\$([\s\S]*)\$\1\$/iu.exec(stripComments(statement).trim())?.[2];
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

export const isSession = (statement: string): boolean =>
  /^(set|reset|begin|commit|end|start|rollback|abort)$/u.test(firstWord(statement));

const TRANSACTION = /^(begin|commit|end|start transaction|rollback|abort)\b/u;

export const isTransactionControl = (statement: string): boolean =>
  TRANSACTION.test(words(statement).join(" "));

export const oneLine = (s: string, n = 160): string => s.replace(/\s+/gu, " ").trim().slice(0, n);

const ident = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const qname = String.raw`(${ident}(?:\s*\.\s*${ident})?)`;
const normalizeName = (name: string): string =>
  name
    .split(/\s*\.\s*/u)
    .map((part) =>
      part.startsWith('"') ? part.slice(1, -1).replace(/""/gu, '"') : part.toLowerCase(),
    )
    .join(".")
    .replace(/^public\./u, "");

/** A statement Spark cannot run, with the Postgres error fields the caller reports. */
export interface SqlRejection {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

/**
 * turso has no `ALTER TABLE ... ADD CONSTRAINT`: a constraint on a table the same script creates
 * moves into its `CREATE TABLE`, and a `UNIQUE` one on an existing table becomes a unique index.
 */
export const foldConstraints = (
  statements: ReadonlyArray<string>,
): { readonly statements: ReadonlyArray<string> } | { readonly rejected: SqlRejection } => {
  const out = [...statements];
  const created = new Map<string, number>();
  const createRe = new RegExp(
    String.raw`^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${qname}\s*\(`,
    "iu",
  );
  const addRe = new RegExp(
    String.raw`^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${qname}\s+add\s+([\s\S]*)$`,
    "iu",
  );
  const isConstraint =
    /^(constraint\s|primary\s+key|unique\s*\(|unique\s+nulls|check\s*\(|foreign\s+key|exclude\s)/iu;
  for (let i = 0; i < out.length; i++) {
    const statement = stripComments(out[i] ?? "")
      .trim()
      .replace(/;\s*$/u, "");
    const create = createRe.exec(statement);
    if (create?.[1] !== undefined) created.set(normalizeName(create[1]), i);
    const add = addRe.exec(statement);
    if (add?.[1] === undefined || add[2] === undefined) continue;
    const table = add[1];
    let element = add[2].trim().replace(/\s+not\s+valid\s*$/iu, "");
    const constraint = isConstraint.test(element);
    if (!constraint) element = element.replace(/^column\s+(if\s+not\s+exists\s+)?/iu, "");
    const at = created.get(normalizeName(table));
    if (at !== undefined) {
      // Studio's table designer creates `CREATE TABLE t ()` and adds every column after it.
      const target = (out[at] ?? "").replace(/;\s*$/u, "");
      const close = target.lastIndexOf(")");
      const empty = /\(\s*$/u.test(target.slice(0, close));
      out[at] = `${target.slice(0, close)}${empty ? "" : ", "}${element}${target.slice(close)}`;
      out[i] = "";
      continue;
    }
    if (!constraint) continue;
    const unique = new RegExp(
      String.raw`^constraint\s+(${ident})\s+unique\s*(\([^)]*\))`,
      "iu",
    ).exec(element);
    if (unique?.[1] !== undefined && unique[2] !== undefined) {
      out[i] = `CREATE UNIQUE INDEX ${unique[1]} ON ${table} ${unique[2]}`;
      continue;
    }
    return {
      rejected: {
        code: "0A000",
        message: `spark cannot add a constraint to an existing table (${table}); create the table with it, or recreate the table`,
        hint: "turso_pg has no ALTER TABLE ... ADD CONSTRAINT",
      },
    };
  }
  return { statements: out.filter((s) => s !== "") };
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

const parseArray = (s: string, base: string): unknown => {
  if (s.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(s);
      return parsed;
    } catch {
      return s;
    }
  }
  if (!/^\{.*\}$/su.test(s)) return s;
  const items: Array<string | null> = [];
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let j = i + 1;
      let value = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") j++;
        value += s[j] ?? "";
        j++;
      }
      items.push(value);
      i = j + 2;
    } else {
      const comma = s.indexOf(",", i);
      const j = comma === -1 ? s.length - 1 : Math.min(comma, s.length - 1);
      const value = s.slice(i, j);
      items.push(value === "NULL" ? null : value);
      i = j + 1;
    }
  }
  const numeric = ["int2", "int4", "int8", "float4", "float8", "numeric"].includes(base);
  return items.map((value) =>
    value === null
      ? null
      : numeric
        ? Number(value)
        : base === "bool"
          ? value === "t" || value === "true"
          : value,
  );
};

/**
 * Spark returns booleans as 0/1 and json and arrays as text: typed back from the description's
 * columns of the tables the query names.
 */
export const coerceRows = (
  model: Model,
  rows: ReadonlyArray<Row>,
  sql: string,
): ReadonlyArray<Row> => {
  if (rows.length === 0) return rows;
  const named = [
    ...stripComments(sql).matchAll(
      /\b(?:from|join|into|update)\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/giu,
    ),
  ].flatMap((match) => {
    const table = match[1] === undefined ? undefined : tableOf(model, match[1]);
    return table === undefined ? [] : [table];
  });
  const types = new Map<string, string>();
  for (const table of named)
    for (const column of table.columns)
      if (!types.has(column.name)) types.set(column.name, column.type);
  if (types.size === 0) return rows;
  return rows.map((row) => {
    const out: Row = { ...row };
    for (const [key, value] of Object.entries(row)) {
      const type = types.get(key);
      if (type === undefined || value === null || value === undefined) continue;
      const info = typeInfo(model.description, type);
      if (info.array && typeof value === "string") out[key] = parseArray(value, info.base);
      else if (info.base === "bool" && typeof value === "number") out[key] = value !== 0;
      else if ((info.base === "json" || info.base === "jsonb") && typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          out[key] = parsed;
        } catch {
          out[key] = value;
        }
      } else if (
        info.base === "timestamptz" &&
        typeof value === "string" &&
        /^\d{4}-\d\d-\d\d[ T][\d:.]+$/u.test(value)
      )
        out[key] = `${value.replace("T", " ")}+00`;
    }
    return out;
  });
};

/** Lowercased, whitespace collapsed and literals replaced, hashed for grouping gap reports. */
export const fingerprint = (sql: string): string => {
  const normalized = sql
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/gu, "?")
    .replace(/\b\d+\b/gu, "?")
    .replace(/\s+/gu, " ")
    .trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++)
    hash = Math.imul(hash ^ normalized.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
};
