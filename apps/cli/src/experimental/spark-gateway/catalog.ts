// Postgres catalog answers computed from spark's schema description (SCHEMA.md), with no Postgres anywhere.
// `model()` turns the description into pg-meta's object shapes; `adapters` maps each catalog query Studio and the
// Supabase MCP server send (matched on distinctive markers, not exact text) to a result in the shape that query returns.

export type Column = {
  name: string;
  position: number;
  type: string;
  not_null: boolean;
  default: string | null;
  identity: "a" | "d" | null;
  generated: string | null;
  comment: string | null;
};
export type Constraint = {
  name: string;
  type: "p" | "u" | "f" | "c";
  def: string;
  columns: string[];
  references: { schema: string; table: string; columns: string[] } | null;
};
export type Table = {
  schema: string;
  name: string;
  managed: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  comment: string | null;
  columns: Column[];
  constraints: Constraint[];
  indexes: { name: string; def: string; unique: boolean; constraint: string | null }[];
  policies: { name: string; cmd: string; permissive: boolean; roles: string[]; using: string | null; check: string | null }[];
};
export type Description = {
  schema_version: string;
  managed_schemas: string[];
  schemas: { name: string; comment: string | null }[];
  enums: { schema: string; name: string; labels: string[]; comment: string | null }[];
  tables: Table[];
  views: { schema: string; name: string; def: string; depends_on: { schema: string; name: string }[]; comment: string | null }[];
};

/** A stable synthetic oid: Studio keys tables, columns and constraints by oid. */
export function oid(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return 16384 + (h % 2_000_000_000);
}

const UDT: Record<string, string> = {
  bigint: "int8", integer: "int4", smallint: "int2", boolean: "bool", "double precision": "float8", real: "float4",
  "timestamp with time zone": "timestamptz", "timestamp without time zone": "timestamp", "time with time zone": "timetz",
  "time without time zone": "time", "character varying": "varchar", character: "bpchar", bit: "bit", "bit varying": "varbit",
};
const baseType = (t: string) => t.replace(/\(.*?\)/, "").trim();

export type TypeInfo = { data_type: string; format: string; format_schema: string; enum?: Description["enums"][number]; array: boolean; base: string };
export function typeInfo(d: Description, type: string): TypeInfo {
  const array = type.endsWith("[]");
  const inner = baseType(array ? type.slice(0, -2) : type);
  const e = d.enums.find((x) => inner === `${x.schema}.${x.name}` || (x.schema === "public" && inner === x.name) || inner === `"${x.schema}"."${x.name}"`);
  const udt = e ? e.name : (UDT[inner] ?? inner);
  return {
    data_type: array ? "ARRAY" : e ? "USER-DEFINED" : inner,
    format: array ? `_${udt}` : udt,
    format_schema: e ? e.schema : "pg_catalog",
    enum: e,
    array,
    base: udt,
  };
}

const FK_ACTION: Record<string, string> = { "NO ACTION": "a", RESTRICT: "r", CASCADE: "c", "SET NULL": "n", "SET DEFAULT": "d" };
const fkAction = (def: string, on: "DELETE" | "UPDATE") => {
  const m = new RegExp(`ON ${on} (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)`, "i").exec(def);
  return m ? FK_ACTION[m[1].toUpperCase()] : "a";
};
const indexColumns = (def: string) => {
  const m = /USING \w+ \((.*)\)\s*(?:INCLUDE|WHERE|$)/i.exec(def) ?? /\((.*)\)/.exec(def);
  return m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")) : [];
};

/** pg-meta shapes for one description. */
export function model(d: Description) {
  const tid = (t: { schema: string; name: string }) => oid(`${t.schema}.${t.name}`);
  const findTable = (schema: string, name: string) => d.tables.find((t) => t.schema === schema && t.name === name);
  const column = (t: Table, c: Column) => {
    const ti = typeInfo(d, c.type);
    const unique = t.constraints.some((k) => k.type === "u" && k.columns.length === 1 && k.columns[0] === c.name);
    const check = t.constraints.find((k) => k.type === "c" && k.columns.length === 1 && k.columns[0] === c.name);
    return {
      table_id: tid(t),
      schema: t.schema,
      table: t.name,
      id: `${tid(t)}.${c.position}`,
      ordinal_position: c.position,
      name: c.name,
      default_value: c.identity ? null : c.default,
      data_type: ti.data_type,
      format: ti.format,
      format_schema: ti.format_schema,
      is_identity: !!c.identity,
      identity_generation: c.identity === "a" ? "ALWAYS" : c.identity === "d" ? "BY DEFAULT" : null,
      is_generated: !!c.generated,
      is_nullable: !c.not_null,
      is_updatable: true,
      is_unique: unique,
      check: check ? check.def.slice(7, -1) : null,
      enums: ti.enum?.labels ?? [],
      comment: c.comment,
    };
  };
  const fks = d.tables.flatMap((t) => t.constraints.filter((k) => k.type === "f" && k.references).map((k) => ({ t, k })));
  const relationship = ({ t, k }: (typeof fks)[number]) => {
    const target = findTable(k.references!.schema, k.references!.table);
    return {
      id: oid(`${t.schema}.${t.name}.${k.name}`),
      constraint_name: k.name,
      deletion_action: fkAction(k.def, "DELETE"),
      update_action: fkAction(k.def, "UPDATE"),
      source_id: tid(t),
      source_schema: t.schema,
      source_table_name: t.name,
      source_column_name: k.columns[0],
      source_columns: k.columns,
      target_id: target ? tid(target) : oid(`${k.references!.schema}.${k.references!.table}`),
      target_table_schema: k.references!.schema,
      target_table_name: k.references!.table,
      target_column_name: k.references!.columns[0],
      target_columns: k.references!.columns,
    };
  };
  const relationshipsOf = (t: Table) =>
    fks.filter(({ t: s, k }) => (s.schema === t.schema && s.name === t.name) || (k.references!.schema === t.schema && k.references!.table === t.name)).map(relationship);
  const primaryKeys = (t: Table) =>
    (t.constraints.find((k) => k.type === "p")?.columns ?? []).map((name) => ({ schema: t.schema, table_name: t.name, name, table_id: tid(t) }));
  const table = (t: Table, withColumns = true) => ({
    id: tid(t),
    schema: t.schema,
    name: t.name,
    rls_enabled: t.rls_enabled,
    rls_forced: t.rls_forced,
    replica_identity: "DEFAULT",
    bytes: 0,
    size: "0 bytes",
    live_rows_estimate: 0,
    dead_rows_estimate: 0,
    comment: t.comment,
    partition_of: null,
    primary_keys: primaryKeys(t),
    relationships: relationshipsOf(t),
    ...(withColumns ? { columns: t.columns.map((c) => column(t, c)) } : {}),
  });
  const view = (v: Description["views"][number]) => ({
    id: tid(v),
    schema: v.schema,
    name: v.name,
    is_updatable: false,
    comment: v.comment,
    columns: [] as unknown[],
  });
  const POLICY_CMD: Record<string, string> = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };
  const policies = () =>
    d.tables.flatMap((t) =>
      t.policies.map((p) => ({
        id: oid(`${t.schema}.${t.name}.policy.${p.name}`),
        schema: t.schema,
        table: t.name,
        table_id: tid(t),
        name: p.name,
        action: p.permissive ? "PERMISSIVE" : "RESTRICTIVE",
        roles: p.roles.length ? p.roles : ["public"],
        command: POLICY_CMD[p.cmd] ?? p.cmd,
        definition: p.using,
        check: p.check,
      })),
    );
  const types = () =>
    d.enums.map((e) => ({
      id: oid(`type.${e.schema}.${e.name}`),
      name: e.name,
      schema: e.schema,
      format: e.schema === "public" ? e.name : `${e.schema}.${e.name}`,
      enums: e.labels,
      attributes: [],
      comment: e.comment,
    }));
  const schemaNames = () => [...new Set([...d.schemas.map((s) => s.name), ...d.managed_schemas, "public"])];
  const schemas = () =>
    schemaNames().map((name) => ({ id: oid(`schema.${name}`), name, owner: d.managed_schemas.includes(name) ? "supabase_admin" : "postgres", comment: d.schemas.find((s) => s.name === name)?.comment ?? null }));
  const byId = (id: number) => d.tables.find((t) => tid(t) === id) ?? d.views.find((v) => tid(v) === id);
  return { d, tid, findTable, column, table, view, relationship, relationshipsOf, fks, primaryKeys, policies, types, schemas, schemaNames, byId };
}
export type Model = ReturnType<typeof model>;

// ---------- query adapters ----------

const ROLES = ["postgres", "anon", "authenticated", "service_role", "supabase_admin", "authenticator", "supabase_auth_admin"];
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** Strings in `in ('a','b')` / `= 'a'` / `in ($1)` after `marker`, with `$n` resolved from the parameters. */
function listAfter(sql: string, marker: RegExp, params: unknown[]): string[] | null {
  const m = new RegExp(marker.source + String.raw`\s*(?:in|IN)\s*\(([^)]*)\)`, "i").exec(sql) ?? new RegExp(marker.source + String.raw`\s*=\s*('[^']*'|\$\d+)`, "i").exec(sql);
  if (!m) return null;
  return m[1].split(",").flatMap((s) => {
    s = s.trim();
    const p = /^\$(\d+)$/.exec(s);
    if (p) {
      const v = params[Number(p[1]) - 1];
      return Array.isArray(v) ? v.map(String) : String(v ?? "").split(",").map((x) => x.trim());
    }
    return [s.replace(/^'|'$/g, "").replace(/''/g, "'")];
  });
}
const notIn = (sql: string, marker: RegExp) => {
  const m = new RegExp(marker.source + String.raw`\s*not\s+in\s*\(([^)]*)\)`, "i").exec(sql);
  return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : [];
};
const oidFilter = (sql: string) => {
  const m = /\b(?:c\.oid|oid|tables\.id|id)\s*=\s*(\d+)/i.exec(sql);
  return m ? Number(m[1]) : null;
};
/** `relname = 'x' and nspname = 'y'` subselects pg-meta uses to pin one table. */
const namedTable = (sql: string) => {
  const m = /relname\s*=\s*'([^']+)'\s+and\s+\w+\.nspname\s*=\s*'([^']+)'/i.exec(sql) ?? /\bname\s*=\s*'([^']+)'\s+and\s+schema\s*=\s*'([^']+)'/i.exec(sql);
  return m ? { name: m[1], schema: m[2] } : null;
};

export type Ctx = { m: Model; sql: string; params: unknown[]; spark: (q: string) => Promise<Record<string, unknown>[]>; migrations: () => Promise<{ version: string; name: string; statements: string[] | null }[]>; coerce: (rows: Record<string, unknown>[], sql: string) => Record<string, unknown>[] };
export type Adapter = { name: string; match: (sql: string) => boolean; run: (c: Ctx) => unknown[] | Promise<unknown[]> };
const has = (...needles: (string | RegExp)[]) => (sql: string) => {
  const lower = sql.toLowerCase();
  return needles.every((n) => (typeof n === "string" ? lower.includes(n.toLowerCase()) : n.test(sql)));
};

/** Tables (pg-meta `tables` CTE, with or without columns) filtered as the query's tail filters them. */
async function tablesQuery({ m, sql, params, spark }: Ctx) {
  const tail = sql.slice(sql.lastIndexOf("from tables") >= 0 ? sql.lastIndexOf("from tables") : 0);
  const includeColumns = /\)\s*as\s+columns\s+from\s+tables/i.test(sql);
  let tables = m.d.tables;
  const schemas = listAfter(tail, /\bschema/, params) ?? listAfter(sql, /nc\.nspname/, params);
  if (schemas) tables = tables.filter((t) => schemas.includes(t.schema));
  const excluded = notIn(tail, /\bschema/);
  if (excluded.length) tables = tables.filter((t) => !excluded.includes(t.schema));
  const named = namedTable(sql);
  if (named) tables = tables.filter((t) => t.name === named.name && t.schema === named.schema);
  const id = /tables\.id\s*=\s*(\d+)|\bc\.oid\s*=\s*(\d+)/i.exec(sql);
  if (id) tables = tables.filter((t) => m.tid(t) === Number(id[1] ?? id[2]));
  const out = tables.map((t) => m.table(t, includeColumns)).sort((a, b) => a.id - b.id);
  // Row counts stand in for pg_stat live tuples (MCP list_tables shows them); managed tables keep 0.
  await Promise.all(
    out.map(async (t) => {
      if (m.d.managed_schemas.includes(t.schema)) return;
      const rows = await spark(`select count(*) as n from ${quoteIdent(t.schema)}.${quoteIdent(t.name)}`).catch(() => []);
      t.live_rows_estimate = Number(rows[0]?.n ?? 0);
    }),
  );
  return out;
}

function entityDefinition({ m, sql }: Ctx) {
  const id = oidFilter(sql);
  const target = id === null ? undefined : m.byId(id);
  if (!target) return [];
  if ("columns" in target) {
    const t = m.table(target);
    const unique_indexes = target.indexes
      .filter((i) => i.unique && !(i.constraint && target.constraints.find((k) => k.name === i.constraint)?.type === "p"))
      .map((i) => ({ schema: target.schema, table_name: target.name, table_id: t.id, columns: indexColumns(i.def) }));
    return [{ entity: { entity_type: "r", ...t, unique_indexes, relationships: t.relationships } }];
  }
  return [{ entity: { entity_type: "v", ...m.view(target) } }];
}

function entities({ m, sql }: Ctx) {
  const schemas = listAfter(sql, /nc\.nspname/, []) ?? ["public"];
  const search = /relname\s+ilike\s+'%?([^'%]*)%?'/i.exec(sql)?.[1]?.toLowerCase();
  const rows = [
    ...m.d.tables.filter((t) => schemas.includes(t.schema)).map((t) => ({ id: m.tid(t), schema: t.schema, name: t.name, type: "r", comment: t.comment, rls_enabled: t.rls_enabled })),
    ...m.d.views.filter((v) => schemas.includes(v.schema)).map((v) => ({ id: m.tid(v), schema: v.schema, name: v.name, type: "v", comment: v.comment, rls_enabled: false })),
  ]
    .filter((r) => !search || r.name.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));
  const limit = Number(/\blimit\s+(\d+)/i.exec(sql)?.[1] ?? 100);
  const offset = Number(/\boffset\s+(\d+)/i.exec(sql)?.[1] ?? 0);
  return [{ data: { entities: rows.slice(offset, offset + limit), count: rows.length } }];
}

/** Table editor rows: `with _base_query as (<spark-runnable select>) select <cols with text truncation> from _base_query`. */
async function tableRows(c: Ctx) {
  const m = /with _base_query as \(([\s\S]*)\)\s*select\s+([\s\S]*?)\s+from _base_query/i.exec(c.sql);
  if (!m) throw new Error("table editor query shape changed");
  const inner = boolLiterals(c.m, m[1]);
  const rows = c.coerce(await c.spark(inner), inner);
  const truncated = [...m[2].matchAll(/when octet_length\((\w+|"[^"]+")::text\) > (\d+)/gi)].map((x) => [x[1].replace(/"/g, ""), Number(x[2])] as const);
  for (const r of rows)
    for (const [col, n] of truncated) {
      const v = r[col];
      if (v !== null && v !== undefined) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        r[col] = s.length > n ? `${s.slice(0, n)}...` : s;
      }
    }
  return rows;
}

/** spark stores booleans as 0/1: `col = 'true'` (the table editor's filter form) compares as text and never matches. */
export function boolLiterals(m: Model, sql: string) {
  const bools = new Set(m.d.tables.flatMap((t) => t.columns.filter((c) => c.type === "boolean").map((c) => c.name)));
  return sql.replace(/("?)(\w+)\1\s*(=|<>|!=)\s*'(true|false|t|f)'/gi, (all, _q, col, op, v) => (bools.has(col) ? `${col} ${op} ${/^t/i.test(v) ? "true" : "false"}` : all));
}

async function countQuery(c: Ctx) {
  const m = /else\s*\(select count\(\*\) from ([\s\S]*?)\)\s*end\s+as\s+count/i.exec(c.sql);
  if (!m) throw new Error("count query shape changed");
  const rows = await c.spark(`select count(*) as count from ${boolLiterals(c.m, m[1])}`);
  return [{ count: Number(rows[0]?.count ?? 0), is_estimate: false }];
}

async function authUsers(c: Ctx) {
  const m = /users_data as \(([\s\S]*?)\)\s*select/i.exec(c.sql);
  if (!m) throw new Error("auth users query shape changed");
  const users = c.coerce(await c.spark(m[1]), "from auth.users");
  const ids = (await c.spark("select user_id, provider from auth.identities")) as { user_id: string; provider: string }[];
  return users.map((u) => ({ ...u, providers: [...new Set(ids.filter((i) => i.user_id === u.id).map((i) => i.provider))] }));
}

async function migrationsQuery(c: Ctx) {
  const ms = await c.migrations();
  return ms
    .map((x) => ({ version: x.version, name: x.name, statements: x.statements }))
    .sort((a, b) => (a.version < b.version ? 1 : -1));
}

function sqlEditorTables({ m, sql }: Ctx) {
  const schemas = listAfter(sql, /where\s+schemaname/, []);
  const rels = [
    ...m.d.tables.map((t) => ({ t, is_table: true, cols: t.columns.map((c) => ({ name: c.name, type: c.type, pos: c.position })) })),
    ...m.d.views.map((v) => ({ t: v, is_table: false, cols: [] as { name: string; type: string; pos: number }[] })),
  ].filter((r) => !schemas || schemas.includes(r.t.schema));
  return rels.map(({ t, is_table, cols }) => ({
    schemaname: t.schema,
    tablename: t.name,
    quoted_name: `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`,
    is_table,
    columns: cols.length ? cols.map((c) => ({ attrelid: m.tid(t), attname: c.name, data_type: c.type, attnum: c.pos, attisdropped: false })) : [null],
  }));
}
export const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

const KEYWORDS = "all and any array as asc between by case cast check collate column constraint create cross default delete desc distinct do else end except false fetch for foreign from full grant group having ilike in inner insert intersect into is join lateral left like limit not null offset on only or order outer primary references returning right select set table then to true union unique update using values when where window with".split(" ");

export const adapters: Adapter[] = [
  { name: "lints", match: has("pg_stat_statements.track", "pgrst.db_schemas"), run: () => [] },
  { name: "migrations", match: has("supabase.studio_migrations"), run: migrationsQuery },
  { name: "count", match: has("pg_temp.count_estimate"), run: countQuery },
  { name: "table-rows-explain", match: has(/^\s*explain\s+with _base_query as/i), run: () => [{ "QUERY PLAN": "Limit  (cost=0.00..1.00 rows=100 width=0)" }] },
  { name: "table-rows", match: has(/^\s*with _base_query as \(/i), run: tableRows },
  { name: "entity-definition", match: has("base_table_info", "'entity_type'"), run: entityDefinition },
  { name: "entities", match: has("with records as", "'entities'"), run: entities },
  { name: "views", match: has(/with\s+views\s+as/i, "pg_relation_is_updatable"), run: ({ m, sql }) => {
      const schemas = listAfter(sql.slice(sql.lastIndexOf("from views")), /\bschema/, []);
      return m.d.views.filter((v) => !schemas || schemas.includes(v.schema)).map(m.view);
    } },
  { name: "materialized-views", match: has(/with\s+materialized_views\s+as/i), run: () => [] },
  { name: "foreign-tables", match: has(/with\s+foreign_tables\s+as/i), run: () => [] },
  { name: "tables", match: (s) => /with\s+(tables\s+as|page\s+as)/i.test(s) && s.includes("primary_keys"), run: tablesQuery },
  { name: "api-docs-table-grants", match: has("table_grants", "total_count"), run: ({ m }) => {
      const t = m.d.tables.filter((x) => !x.managed);
      return [{ total_count: t.length, tables: t.map((x) => ({ id: m.tid(x), schema: x.schema, name: x.name, status: "granted" })) }];
    } },
  { name: "api-docs-function-grants", match: has("function_grants", "total_count"), run: () => [{ total_count: 0, functions: [] }] },
  { name: "table-privileges", match: has("with table_privileges as", "aclexplode", "privilege_type"), run: ({ m, sql }) => {
      const schemas = listAfter(sql, /nc\.nspname/, []) ?? m.schemaNames();
      return m.d.tables.filter((t) => schemas.includes(t.schema)).map((t) => ({
        relation_id: m.tid(t), schema: t.schema, name: t.name, kind: "table",
        privileges: ROLES.slice(0, 4).flatMap((grantee) => PRIVS.map((privilege_type) => ({ grantor: "postgres", grantee, privilege_type, is_grantable: false }))),
      }));
    } },
  { name: "schemas", match: has("information_schema.schemata", "pg_namespace"), run: ({ m }) => m.schemas() },
  { name: "foreign-servers", match: has("pg_foreign_server", "srvoptions"), run: () => [] },
  { name: "publications", match: has("pg_publication", "publish_insert"), run: () => [
      { id: oid("pub.supabase_realtime"), name: "supabase_realtime", owner: "postgres", publish_insert: true, publish_update: true, publish_delete: true, publish_truncate: true, tables: [] },
    ] },
  { name: "extensions", match: has("pg_available_extensions"), run: () => [] },
  { name: "policies", match: has("pg_policy", "polname"), run: ({ m, sql, params }) => {
      const schemas = listAfter(sql.slice(sql.lastIndexOf("from policies")), /\bschema/, params);
      const tableId = /table_id\s*=\s*(\d+)/i.exec(sql)?.[1];
      return m.policies().filter((p) => (!schemas || schemas.includes(p.schema)) && (!tableId || p.table_id === Number(tableId)));
    } },
  { name: "foreign-keys", match: has("con.confdeltype as deletion_action", "source_columns"), run: ({ m, sql }) => {
      const schemas = listAfter(sql, /nsp\.nspname/, []);
      return m.fks.filter(({ t }) => !schemas || schemas.includes(t.schema)).map((fk) => {
        const r = m.relationship(fk);
        return { id: r.id, constraint_name: r.constraint_name, deletion_action: r.deletion_action, update_action: r.update_action, source_id: r.source_id, source_schema: r.source_schema, source_table: r.source_table_name, source_columns: r.source_columns, target_id: r.target_id, target_schema: r.target_table_schema, target_table: r.target_table_name, target_columns: r.target_columns };
      });
    } },
  { name: "types", match: has("pg_type", "pg_enum", "typrelid"), run: ({ m, sql }) => {
      const schemas = listAfter(sql, /n\.nspname/, []);
      return m.types().filter((t) => !schemas || schemas.includes(t.schema));
    } },
  { name: "table-constraints", match: has("with table_info as", "con.contype as type"), run: ({ m, sql }) => {
      const t = m.byId(oidFilter(sql) ?? -1);
      if (!t || !("constraints" in t)) return [];
      return t.constraints.map((k) => ({ id: oid(`${t.schema}.${t.name}.${k.name}`), name: k.name, type: k.type }));
    } },
  { name: "default-privileges", match: has("pg_default_acl", "grant_count"), run: () => [{ grant_count: 3 }] },
  { name: "event-triggers", match: has("pg_event_trigger"), run: () => [] },
  { name: "functions", match: has(/with\s+f\s+as/i, "arg_modes"), run: () => [] },
  { name: "functions-pg-meta", match: has("pg_proc", "prosrc", "proname"), run: () => [] },
  { name: "triggers", match: has("pg_trigger", "information_schema.triggers"), run: () => [] },
  { name: "roles", match: has("pg_roles", "rolcanlogin", "activeConnections"), run: () =>
      ROLES.map((name) => ({ id: oid(`role.${name}`), name, isSuperuser: name === "postgres" || name === "supabase_admin", canCreateDb: name === "postgres", canCreateRole: name === "postgres", inheritRole: true, canLogin: ["postgres", "authenticator", "supabase_admin", "supabase_auth_admin"].includes(name), isReplicationRole: false, canBypassRls: ["postgres", "service_role", "supabase_admin"].includes(name), activeConnections: 0, connectionLimit: 100, validUntil: null, config: {} })) },
  { name: "indexes", match: has("pg_get_indexdef(idx.indexrelid)", "string_agg"), run: ({ m, sql }) => {
      const schemas = listAfter(sql, /n\.nspname/, []);
      return m.d.tables.filter((t) => !schemas || schemas.includes(t.schema)).flatMap((t) => t.indexes.map((i) => ({ schema: t.schema, table: t.name, name: i.name, definition: i.def, columns: indexColumns(i.def).join(", ") })));
    } },
  { name: "sql-editor-tables", match: has("quoted_name", "is_table", "json_agg(a)"), run: sqlEditorTables },
  { name: "auth-indexes", match: has("indisvalid as is_valid", "indisready"), run: ({ sql }) =>
      [...(/relname IN \(([^)]*)\)/i.exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => ({ index_name: x[1], is_valid: true, is_ready: true })) },
  { name: "auth-index-worker", match: has("pg_locks", "auth_index_worker"), run: () => [{ is_in_progress: false }] },
  { name: "auth-users", match: has("users_data as", "auth.identities"), run: authUsers },
  { name: "keywords", match: has("pg_get_keywords"), run: () => KEYWORDS.map((word) => ({ word })) },
  { name: "show", match: has(/^\s*show\s+\w+\s*;?\s*$/i), run: ({ sql }) => {
      const k = /show\s+(\w+)/i.exec(sql)![1].toLowerCase();
      return [{ [k]: SETTINGS[k] ?? "" }];
    } },
  { name: "current-setting", match: has(/^\s*select\s+current_setting\s*\(\s*'[^']+'\s*(,\s*\w+\s*)?\)(\s+as\s+\w+)?\s*;?\s*$/i), run: ({ sql }) => {
      const m = /current_setting\s*\(\s*'([^']+)'/i.exec(sql)!;
      const alias = /\bas\s+(\w+)/i.exec(sql)?.[1] ?? "current_setting";
      return [{ [alias]: SETTINGS[m[1].toLowerCase()] ?? null }];
    } },
];

const SETTINGS: Record<string, string> = {
  max_connections: "100", server_version_num: "170000", server_version: "17.0", search_path: '"$user", public, extensions',
  "pgrst.db_schemas": "public,graphql_public", statement_timeout: "0", timezone: "UTC",
};

/** Fingerprint as the inventory computes it: lowercased, whitespace collapsed, literals -> ?. */
export function fingerprint(sql: string) {
  const norm = sql.toLowerCase().replace(/'(?:[^']|'')*'/g, "?").replace(/\b\d+\b/g, "?").replace(/\s+/g, " ").trim();
  return new Bun.CryptoHasher("sha1").update(norm).digest("hex").slice(0, 10);
}
