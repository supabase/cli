import type { Description, Table } from "./Description.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const qualified = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const POLICY_COMMAND: Readonly<Record<string, string>> = {
  r: "select",
  select: "select",
  a: "insert",
  insert: "insert",
  w: "update",
  update: "update",
  d: "delete",
  delete: "delete",
  "*": "all",
  all: "all",
};

const REFERENCES_TARGET =
  /\breferences\s+(?:"(?:[^"]|"")+"|[^\s(".]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[^\s(".]+))?\s*\(/iu;

/** The constraint definition with an unqualified or unquoted foreign key target made explicit. */
const foreignKeyDef = (c: Table["constraints"][number]) => {
  const target = c.references;
  return target === null
    ? c.def
    : c.def.replace(
        REFERENCES_TARGET,
        () => `REFERENCES ${qualified(target.schema, target.table)} (`,
      );
};

/** True when one pair of parentheses encloses the whole expression. */
const wrapped = (expression: string) => {
  const text = expression.trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (const [index, char] of [...text].entries()) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && index < text.length - 1) return false;
  }
  return depth === 0;
};
const parenthesized = (expression: string) =>
  wrapped(expression) ? expression.trim() : `(${expression.trim()})`;

const policyRole = (role: string) => (role === "public" ? "PUBLIC" : quote(role));

const columnLine = (column: Table["columns"][number]) => {
  const parts = [quote(column.name), column.type];
  if (column.identity !== null)
    parts.push(`generated ${column.identity === "a" ? "always" : "by default"} as identity`);
  else if (column.generated !== null)
    parts.push(`generated always as ${parenthesized(column.generated)} stored`);
  else if (column.default !== null) parts.push(`default ${column.default}`);
  if (column.not_null) parts.push("not null");
  return parts.join(" ");
};

const viewOrder = (views: Description["views"]) => {
  const key = (v: { readonly schema: string; readonly name: string }) =>
    JSON.stringify([v.schema, v.name]);
  const pending = new Map(views.map((v) => [key(v), v]));
  const ordered: Array<Description["views"][number]> = [];
  const visit = (view: Description["views"][number]) => {
    if (!pending.delete(key(view))) return;
    for (const dependency of [...view.depends_on].sort((a, b) => byName(key(a), key(b)))) {
      const next = pending.get(key(dependency));
      if (next !== undefined) visit(next);
    }
    ordered.push(view);
  };
  for (const view of [...views].sort((a, b) => byName(key(a), key(b)))) visit(view);
  return ordered;
};

/** Schema-only Postgres DDL for the objects Spark runs; managed schemas and tables are left to the target. */
export const renderDump = (description: Description, schemas?: ReadonlyArray<string>): string => {
  const managed = new Set(description.managed_schemas);
  const wanted = (schema: string) =>
    !managed.has(schema) && (schemas === undefined || schemas.includes(schema));
  const tables = description.tables
    .filter((t) => !t.managed && wanted(t.schema))
    .sort((a, b) => byName(qualified(a.schema, a.name), qualified(b.schema, b.name)));
  const enums = description.enums
    .filter((e) => wanted(e.schema))
    .sort((a, b) => byName(qualified(a.schema, a.name), qualified(b.schema, b.name)));
  const views = viewOrder(description.views.filter((v) => wanted(v.schema)));
  const schemaRows = description.schemas
    .filter((s) => wanted(s.name))
    .sort((a, b) => byName(a.name, b.name));

  const out: Array<string> = [];
  for (const schema of schemaRows)
    if (schema.name !== "public") out.push(`create schema if not exists ${quote(schema.name)};`);
  for (const e of enums)
    out.push(
      `create type ${qualified(e.schema, e.name)} as enum (${e.labels.map(literal).join(", ")});`,
    );

  for (const table of tables) {
    const lines = [
      ...[...table.columns].sort((a, b) => a.position - b.position).map(columnLine),
      ...table.constraints
        .filter((c) => c.type !== "f")
        .sort((a, b) => byName(a.name, b.name))
        .map((c) => `constraint ${quote(c.name)} ${c.def}`),
    ];
    out.push(
      `create table ${qualified(table.schema, table.name)} (\n${lines.map((l) => `  ${l}`).join(",\n")}\n);`,
    );
  }
  for (const table of tables)
    for (const index of table.indexes
      .filter((i) => i.constraint === null)
      .sort((a, b) => byName(a.name, b.name)))
      out.push(`${index.def.trim()};`);
  for (const table of tables)
    for (const c of table.constraints
      .filter((c) => c.type === "f")
      .sort((a, b) => byName(a.name, b.name)))
      out.push(
        `alter table ${qualified(table.schema, table.name)} add constraint ${quote(c.name)} ${foreignKeyDef(c)};`,
      );

  for (const view of views)
    out.push(
      `create view ${qualified(view.schema, view.name)} as ${view.def.trim().replace(/;$/u, "")};`,
    );

  for (const table of tables) {
    const name = qualified(table.schema, table.name);
    if (table.rls_enabled) out.push(`alter table ${name} enable row level security;`);
    if (table.rls_forced) out.push(`alter table ${name} force row level security;`);
  }
  for (const table of tables)
    for (const policy of [...table.policies].sort((a, b) => byName(a.name, b.name))) {
      const roles = policy.roles.length === 0 ? "public" : policy.roles.map(policyRole).join(", ");
      const clauses = [
        `create policy ${quote(policy.name)} on ${qualified(table.schema, table.name)}`,
        `as ${policy.permissive ? "permissive" : "restrictive"}`,
        `for ${POLICY_COMMAND[policy.cmd] ?? "all"}`,
        `to ${roles}`,
      ];
      if (policy.using !== null) clauses.push(`using ${parenthesized(policy.using)}`);
      if (policy.check !== null) clauses.push(`with check ${parenthesized(policy.check)}`);
      out.push(`${clauses.join(" ")};`);
    }

  const comment = (target: string, text: string | null) => {
    if (text !== null) out.push(`comment on ${target} is ${literal(text)};`);
  };
  for (const schema of schemaRows) comment(`schema ${quote(schema.name)}`, schema.comment);
  for (const e of enums) comment(`type ${qualified(e.schema, e.name)}`, e.comment);
  for (const table of tables) {
    const name = qualified(table.schema, table.name);
    comment(`table ${name}`, table.comment);
    for (const column of table.columns)
      comment(`column ${name}.${quote(column.name)}`, column.comment);
  }
  for (const view of views) comment(`view ${qualified(view.schema, view.name)}`, view.comment);

  return out.length === 0 ? "" : `${out.join("\n\n")}\n`;
};
