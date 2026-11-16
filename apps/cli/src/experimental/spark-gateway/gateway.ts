// Supabase Spark dev gateway: one URL (like Kong in `supabase start`) in front of spark, with no Postgres anywhere.
// Data, SQL and migrations go to spark's admin API; catalog questions are answered from spark's schema description
// (SCHEMA.md) by the query adapters in catalog.ts. Stateless apart from a description cache keyed by schema_version.
// Routes:
//   /rest/v1/*, /auth/v1/*            -> spark (GET /rest/v1/ is the OpenAPI document, built from the description)
//   POST /pg/query                     -> routed SQL (see `runSql`)
//   GET /pg/<resource>                 -> pg-meta REST shapes from the description
//   /v1/projects/:ref/*                -> Management API subset for MCP and the CLI
//   GET /_dev/status, POST /_dev/sync  -> gateway status, refresh the description
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapters, boolLiterals, type Description, fingerprint, type Model, model, typeInfo } from "./catalog.ts";
import { typescript } from "./typegen.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const PORT = Number(env("GATEWAY_PORT", "54321"));
const SPARK_URL = env("SPARK_URL", "http://127.0.0.1:54331");
const SERVICE_KEY = env("SERVICE_ROLE_KEY");
const ANON_KEY = env("ANON_KEY");
const PROJECT_REF = env("PROJECT_REF", "default");
const PUBLIC_URL = env("PUBLIC_URL", `http://127.0.0.1:${PORT}`);
const MIGRATIONS_DIR = env("MIGRATIONS_DIR", "supabase/migrations");
const GAPS_FILE = env("GAPS_FILE", "supabase/.spark/gaps.jsonl");

// ---------- SQL classification ----------

/** Splits on top-level `;`, honoring quotes, dollar quotes and comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      cur += sql.slice(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
      } else {
        cur += c;
        i++;
      }
    } else if (c === ";") {
      if (stripComments(cur).trim()) out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (stripComments(cur).trim()) out.push(cur.trim());
  return out;
}

const stripComments = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const words = (s: string) => stripComments(s).trim().toLowerCase().split(/\s+/);


const DDL = new Set(["create", "alter", "drop", "comment", "grant", "revoke", "security"]);
/** Session-local objects (Studio's `pg_temp` helpers) are not schema changes. */
const isTempObject = (stmt: string) => /^create (or replace )?(temp|temporary )?\s*(function|table|view)?\s*pg_temp\./.test(words(stmt).join(" ")) || /^create (temp|temporary) /.test(words(stmt).join(" "));
const isDdl = (stmt: string) => DDL.has(words(stmt)[0] ?? "") && !isTempObject(stmt);
/** A `DO` block that only grants or revokes (Studio's "new table" grants): grants are no-ops on spark (RLS is the access control). */
const isGrantDo = (stmt: string) => {
  const body = /^do\s+\$(\w*)\$([\s\S]*)\$\1\$/i.exec(stripComments(stmt).trim())?.[2];
  if (!body) return false;
  const lines = body.split(";").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "begin" && s !== "end");
  return lines.every((l) => /^(begin\s+)?execute format\('(grant|revoke) /.test(l) || /^(begin\s+)?(grant|revoke) /.test(l));
};
const isSession = (stmt: string) => /^(set|reset|begin|commit|end|start|rollback|abort)$/.test(words(stmt)[0] ?? "");

// ---------- spark ----------

type DbErr = { code?: string; message: string; details?: string | null; hint?: string | null };
class QueryError extends Error {
  constructor(public err: DbErr, public status = 400) {
    super(err.message);
  }
}

async function sparkFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SPARK_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", apikey: SERVICE_KEY, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text };
  }
  if (!res.ok) throw new QueryError(body ?? { message: res.statusText }, res.status);
  return body;
}
type Row = Record<string, unknown>;
const sparkQuery = (query: string, parameters: unknown[] = [], read_only = false): Promise<Row[]> =>
  sparkFetch("/_spark/v1/query", { method: "POST", body: JSON.stringify({ query, parameters, read_only }) });
type SparkMigration = { version: string; name: string; statements: string[] | null };
const sparkMigrations = (): Promise<SparkMigration[]> => sparkFetch("/_spark/v1/migrations");

// ---------- schema description cache ----------

let cached: { version: string; model: Model } | null = null;
/** The description for spark's current schema_version (cheap check; the full description only when it changed). */
async function current(): Promise<Model> {
  const { schema_version } = await sparkFetch("/_spark/v1/schema/version");
  if (cached?.version !== schema_version) {
    const d: Description = await sparkFetch("/_spark/v1/schema");
    cached = { version: d.schema_version, model: model(d) };
  }
  return cached.model;
}
const invalidate = () => {
  cached = null;
};

// ---------- spark DDL shims ----------

const ident = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const qname = String.raw`(${ident}(?:\s*\.\s*${ident})?)`;
const norm = (n: string) =>
  n
    .split(/\s*\.\s*/)
    .map((p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase()))
    .join(".")
    .replace(/^public\./, "");
/**
 * turso has no `ALTER TABLE ... ADD CONSTRAINT` (pg-delta emits foreign keys that way). A constraint on a table the same
 * migration creates moves into its `CREATE TABLE`; a `UNIQUE` one on an existing table becomes a unique index.
 */
function foldConstraints(stmts: string[]): string[] {
  const out = [...stmts];
  const created = new Map<string, number>();
  const createRe = new RegExp(String.raw`^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${qname}\s*\(`, "i");
  const addRe = new RegExp(String.raw`^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${qname}\s+add\s+([\s\S]*)$`, "i");
  const isConstraint = /^(constraint\s|primary\s+key|unique\s*\(|unique\s+nulls|check\s*\(|foreign\s+key|exclude\s)/i;
  for (let i = 0; i < out.length; i++) {
    const stmt = stripComments(out[i]).trim().replace(/;\s*$/, "");
    const c = createRe.exec(stmt);
    if (c) created.set(norm(c[1]), i);
    const a = addRe.exec(stmt);
    if (!a) continue;
    const table = norm(a[1]);
    let element = a[2].trim().replace(/\s+not\s+valid\s*$/i, "");
    const constraint = isConstraint.test(element);
    if (!constraint) element = element.replace(/^column\s+(if\s+not\s+exists\s+)?/i, "");
    const at = created.get(table);
    if (at !== undefined) {
      // Studio's table designer creates `CREATE TABLE t ()` and adds every column after it.
      const create = out[at].replace(/;\s*$/, "");
      const close = create.lastIndexOf(")");
      const empty = /\(\s*$/.test(create.slice(0, close));
      out[at] = `${create.slice(0, close)}${empty ? "" : ", "}${element}${create.slice(close)}`;
      out[i] = "";
      continue;
    }
    if (!constraint) continue; // ADD COLUMN on an existing table: spark runs it.
    const u = new RegExp(String.raw`^constraint\s+(${ident})\s+unique\s*(\([^)]*\))`, "i").exec(element);
    if (u) {
      out[i] = `CREATE UNIQUE INDEX ${u[1]} ON ${a[1]} ${u[2]}`;
      continue;
    }
    throw new QueryError({
      code: "0A000",
      message: `spark cannot add a constraint to an existing table (${a[1]}); create the table with it, or recreate the table`,
      hint: "turso_pg has no ALTER TABLE ... ADD CONSTRAINT",
    });
  }
  return out.filter(Boolean);
}

// ---------- schema changes ----------

type Status = { index: number; kind: string; status: string; message?: string | null; line?: number };
const TX = /^(begin|commit|end|start transaction|rollback|abort)\b/;
/** Applies a schema change as a spark migration and writes it to supabase/migrations. */
async function applySchemaChange(sql: string, name: string, wanted?: string) {
  // A spark migration is atomic already; spark refuses transaction control inside scripts.
  const stmts = splitSql(sql).filter((s) => !TX.test(words(s).join(" ")) && !isGrantDo(s));
  const forSpark = foldConstraints(stmts);
  const script = forSpark.join(";\n") + ";";
  const latest = (await sparkMigrations()).map((m) => m.version).sort().at(-1) ?? "0";
  let version = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  if (wanted) {
    if (/^\d+$/.test(latest) && BigInt(wanted) <= BigInt(latest))
      throw new QueryError({ code: "22023", message: `migration version ${wanted} is not after the latest applied version ${latest}` });
    version = wanted;
  } else if (/^\d+$/.test(latest) && BigInt(version) <= BigInt(latest)) version = (BigInt(latest) + 1n).toString();
  if (forSpark.length) {
    // Validated on a scratch database (the project's migrations replayed in memory), so the live data is never touched.
    const dry = await sparkFetch("/_spark/v1/scratch", { method: "POST", body: JSON.stringify({ base: "current", files: [{ name: `${version}_${name}.sql`, sql: script }], order: "as_given" }) });
    const bad = (dry.statuses as Status[]).filter((s) => s.status === "unsupported" || s.status === "error");
    if (bad.length) {
      const lines = bad.map((s) => `${s.status === "unsupported" ? "Not supported on Spark" : "Error"} (${s.kind}): ${oneLine(forSpark[s.index] ?? "", 100)}${s.message ? ` -- ${s.message}` : ""}`);
      logGap(name, script, { code: bad[0].status, message: lines.join("; ") }, false);
      throw new QueryError({ code: bad[0].status === "unsupported" ? "0A000" : "42000", message: lines.join("\n"), hint: "spark runs tables, views, indexes, enums and RLS policies; functions, triggers and extensions are not supported" });
    }
    await sparkFetch("/_spark/v1/migrations", { method: "POST", body: JSON.stringify({ version, name, sql: script }) });
    invalidate();
  } else {
    // Only grants or comments: nothing for spark, and no migration.
    return null;
  }
  // What spark ran (no transaction control, constraints folded), so `spark db reset` replays it the same way.
  writeMigrationFile(version, name, script);
  return version;
}

/** Schema changes made from Studio or MCP become migration files, as `supabase migration fetch` would write them. */
function writeMigrationFile(version: string, name: string, sql: string) {
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const exists = readdirSync(MIGRATIONS_DIR).some((f) => f.startsWith(`${version}_`));
  if (!exists) writeFileSync(join(MIGRATIONS_DIR, `${version}_${name.replace(/[^A-Za-z0-9_]+/g, "_")}.sql`), sql.trim() + "\n");
}

// ---------- table editor writes ----------

const lit = (v: unknown, type: string | undefined): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const str = (s: string) => `'${s.replace(/'/g, "''")}'`;
  if (Array.isArray(v) && type?.endsWith("[]"))
    return str(`{${v.map((x) => (x === null ? "NULL" : `"${String(typeof x === "object" ? JSON.stringify(x) : x).replace(/["\\]/g, "\\$&")}"`)).join(",")}}`);
  if (typeof v === "object") return str(JSON.stringify(v));
  return str(String(v));
};
const unq = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
/**
 * The table editor writes through `json(b)_populate_record(set)`, which spark lacks: the same insert or update with
 * literals instead.
 */
function rewriteEditorWrite(m: Model, sql: string): string | null {
  // A row saved with every column left at its default.
  const empty = /^\s*insert\s+into\s+([\w."]+)\s+select\s+from\s+jsonb?_populate_recordset\s*\(\s*null::[\w."]+\s*,\s*'((?:[^']|'')*)'\s*\)([\s\S]*)$/i.exec(sql);
  if (empty) {
    // turso has no DEFAULT VALUES; one column set to DEFAULT is the same row.
    const first = tableOf(m, empty[1])?.columns[0]?.name;
    const n = (JSON.parse(empty[2].replace(/''/g, "'")) as Row[]).length;
    if (!first || n === 0) return null;
    const rows = Array.from({ length: n }, () => "(default)").join(", ");
    return `insert into ${empty[1]} (${quote(first)}) values ${rows}${empty[3].trim().replace(/^;$/, "")}`;
  }
  const ins = /^\s*insert\s+into\s+([\w."]+)\s*\(([^)]*)\)\s*select\s+[^;]*?\s+from\s+jsonb?_populate_recordset\s*\(\s*null::[\w."]+\s*,\s*('(?:[^']|'')*')\s*\)([\s\S]*)$/i.exec(sql);
  if (ins) {
    const t = tableOf(m, ins[1]);
    const cols = ins[2].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const rows = JSON.parse(unq(ins[3])) as Row[];
    const type = (c: string) => t?.columns.find((x) => x.name === c)?.type;
    const values = rows.map((r) => `(${cols.map((c) => lit(r[c], type(c))).join(", ")})`).join(", ");
    return `insert into ${ins[1]} (${ins[2]}) values ${values}${ins[4].trim().replace(/^;$/, "")}`;
  }
  const upd = /^\s*update\s+([\w."]+)\s+set\s*\(([^)]*)\)\s*=\s*\(\s*select\s+[^;]*?\s+from\s+jsonb?_populate_record\s*\(\s*null::[\w."]+\s*,\s*('(?:[^']|'')*')\s*\)\s*\)([\s\S]*)$/i.exec(sql);
  if (upd) {
    const t = tableOf(m, upd[1]);
    const cols = upd[2].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const row = JSON.parse(unq(upd[3])) as Row;
    const type = (c: string) => t?.columns.find((x) => x.name === c)?.type;
    return `update ${upd[1]} set ${cols.map((c) => `${quote(c)} = ${lit(row[c], type(c))}`).join(", ")}${boolLiterals(m, upd[4])}`;
  }
  return null;
}
const quote = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
function tableOf(m: Model, qname: string) {
  const parts = qname.split(".").map((p) => p.replace(/^"|"$/g, ""));
  const [schema, name] = parts.length === 2 ? parts : ["public", parts[0]];
  return m.findTable(schema, name);
}

// ---------- result types ----------

/**
 * spark returns booleans as 0/1, json and arrays as text (R6, R7, C-01): typed back from the description's columns of
 * the tables the query names.
 */
function coerce(m: Model, rows: Row[], sql: string): Row[] {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const text = stripComments(sql);
  const named = [...text.matchAll(/\b(?:from|join|into|update)\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/gi)].map((x) => tableOf(m, x[1])).filter(Boolean);
  const types = new Map<string, string>();
  for (const t of named) for (const c of t!.columns) if (!types.has(c.name)) types.set(c.name, c.type);
  if (!types.size) return rows;
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) {
      const type = types.get(k);
      if (!type || v === null || v === undefined) continue;
      const ti = typeInfo(m.d, type);
      if (ti.array && typeof v === "string") r[k] = parseArray(v, ti.base);
      else if (ti.base === "bool" && typeof v === "number") r[k] = v !== 0;
      else if ((ti.base === "json" || ti.base === "jsonb") && typeof v === "string") {
        try {
          r[k] = JSON.parse(v);
        } catch {}
      } else if (ti.base === "timestamptz" && typeof v === "string" && /^\d{4}-\d\d-\d\d[ T][\d:.]+$/.test(v)) r[k] = `${v.replace("T", " ")}+00`;
    }
  return rows;
}
function parseArray(s: string, base: string): unknown {
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  if (!/^\{.*\}$/s.test(s)) return s;
  const items: (string | null)[] = [];
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") j++;
        v += s[j++];
      }
      items.push(v);
      i = j + 2;
    } else {
      const j = s.indexOf(",", i) === -1 ? s.length - 1 : Math.min(s.indexOf(",", i), s.length - 1);
      const v = s.slice(i, j);
      items.push(v === "NULL" ? null : v);
      i = j + 1;
    }
  }
  const num = ["int2", "int4", "int8", "float4", "float8", "numeric"].includes(base);
  return items.map((v) => (v === null ? null : num ? Number(v) : base === "bool" ? v === "t" || v === "true" : v));
}

// ---------- routed SQL ----------

type Routed = { rows: unknown[]; target: string };
const DEBUG = !!process.env.GATEWAY_DEBUG;
const oneLine = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * pg-meta `/query` semantics over spark:
 *  1. DDL -> a spark migration (dry-run first: `unsupported` statements are refused by name)
 *  2. a catalog query Studio or MCP sends -> its adapter, answered from the schema description
 *  3. the table editor's populate_record writes -> plain INSERT/UPDATE
 *  4. everything else -> spark, results typed from the description; failures are logged to the gaps file
 */
async function runSql(query: string, parameters: unknown[] = [], readOnly = false, source = "studio"): Promise<Routed> {
  try {
    const r = await routeSql(query, parameters, readOnly, source);
    if (DEBUG) console.log(`[sql] ${source} -> ${r.target}: ${oneLine(query)}`);
    return r;
  } catch (e) {
    if (DEBUG) console.log(`[sql] ${source} FAILED (${(e as Error).message}): ${oneLine(query)}`);
    throw e;
  }
}

async function routeSql(query: string, parameters: unknown[], readOnly: boolean, source: string): Promise<Routed> {
  const stmts = splitSql(query);
  if (stmts.length && stmts.every((s) => isGrantDo(s) || isSession(s) || (isDdl(s) && /^(grant|revoke|comment)$/.test(words(s)[0])))) {
    // Grants, comments and session settings only: no-ops on spark.
    if (stmts.some((s) => !isSession(s))) return { rows: [], target: "ignored" };
  }
  if (stmts.some(isDdl)) {
    if (readOnly) throw new QueryError({ code: "25006", message: "cannot execute DDL in a read-only transaction" });
    await applySchemaChange(query, source);
    return { rows: [], target: "migration" };
  }
  const m = await current();
  const adapter = adapters.find((a) => a.match(query));
  if (adapter) {
    const rows = await adapter.run({
      m,
      sql: query,
      params: parameters,
      spark: (q) => sparkQuery(q, [], true),
      migrations: sparkMigrations,
      coerce: (rows, sql) => coerce(m, rows, sql),
    });
    return { rows, target: `adapter:${adapter.name}` };
  }
  const body = stmts.filter((s) => !isSession(s) && !(/^do\s+\$/i.test(s.trim()) && /pg_stat_statements\.track/.test(s)));
  if (!body.length) return { rows: [], target: "ignored" };
  let sql = body.length === 1 ? body[0] : body.join(";\n");
  const rewritten = stmts.length === 1 ? rewriteEditorWrite(m, stmts[0]) : null;
  if (rewritten) sql = rewritten;
  if (/^\s*explain\b/i.test(sql)) return { rows: [{ "QUERY PLAN": "Result  (cost=0.00..0.01 rows=1 width=0)" }], target: "explain" };
  try {
    const rows = await sparkQuery(sql, parameters, readOnly);
    return { rows: coerce(m, rows, sql), target: rewritten ? "spark:rewritten" : "spark" };
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    const catalog = /\b(pg_catalog|information_schema)\b|\bpg_[a-z_]+\b|::regclass|\bplpgsql\b/i.test(stripComments(query));
    logGap(source, query, e.err, catalog);
    if (catalog)
      throw new QueryError({ ...e.err, message: `${e.err.message}\nNot supported on Spark (catalog query not adapted): ${oneLine(query, 80)}` });
    throw e;
  }
}

function logGap(source: string, query: string, err: DbErr, catalog: boolean) {
  try {
    mkdirSync(dirname(GAPS_FILE), { recursive: true });
    appendFileSync(GAPS_FILE, JSON.stringify({ at: new Date().toISOString(), source, catalog, fingerprint: fingerprint(query), error: `${err.code ?? ""} ${err.message}`, query: oneLine(query, 300) }) + "\n");
  } catch (e) {
    console.error("[gaps] cannot write", GAPS_FILE, (e as Error).message);
  }
}

// ---------- OpenAPI (spark has no PostgREST root document yet) ----------

const OPENAPI_TYPES: Record<string, string> = {
  int2: "integer", int4: "integer", int8: "integer", float4: "number", float8: "number", numeric: "number", bool: "boolean", json: "object", jsonb: "object",
};
/** PostgREST's Swagger 2.0 document for the `public` schema, built from the description. */
async function openApi() {
  const m = await current();
  const definitions: Record<string, any> = {};
  const paths: Record<string, any> = { "/": { get: { produces: ["application/openapi+json", "application/json"], responses: { "200": { description: "OK" } }, summary: "OpenAPI description (this document)", tags: ["Introspection"] } } };
  for (const t of m.d.tables.filter((x) => x.schema === "public")) {
    const pk = t.constraints.find((k) => k.type === "p")?.columns ?? [];
    const d = (definitions[t.name] = { type: "object", properties: {} as Record<string, any>, required: [] as string[], ...(t.comment ? { description: t.comment } : {}) });
    for (const c of t.columns) {
      const ti = typeInfo(m.d, c.type);
      const isPk = pk.includes(c.name);
      d.properties[c.name] = {
        type: ti.array ? "array" : (OPENAPI_TYPES[ti.base] ?? "string"),
        format: c.type,
        ...(ti.enum ? { enum: ti.enum.labels } : {}),
        ...(c.comment || isPk ? { description: [c.comment, isPk ? "Note:\nThis is a Primary Key.<pk/>" : ""].filter(Boolean).join("\n\n") } : {}),
      };
      if (c.not_null && c.default === null && !c.identity) d.required.push(c.name);
    }
  }
  for (const v of m.d.views.filter((x) => x.schema === "public")) definitions[v.name] = { type: "object", properties: {}, ...(v.comment ? { description: v.comment } : {}) };
  for (const [table, def] of Object.entries(definitions)) {
    const ref = { $ref: `#/definitions/${table}` };
    const rowFilters = Object.keys(def.properties).map((name) => ({ $ref: `#/parameters/rowFilter.${table}.${name}` }));
    paths[`/${table}`] = {
      get: { tags: [table], parameters: [...rowFilters, { $ref: "#/parameters/select" }, { $ref: "#/parameters/order" }, { $ref: "#/parameters/limit" }], responses: { "200": { description: "OK", schema: { type: "array", items: ref } } } },
      post: { tags: [table], parameters: [{ $ref: `#/parameters/body.${table}` }, { $ref: "#/parameters/preferPost" }], responses: { "201": { description: "Created" } } },
      patch: { tags: [table], parameters: [...rowFilters, { $ref: `#/parameters/body.${table}` }], responses: { "204": { description: "No Content" } } },
      delete: { tags: [table], parameters: rowFilters, responses: { "204": { description: "No Content" } } },
    };
  }
  const parameters: Record<string, any> = {
    select: { name: "select", description: "Filtering Columns", required: false, in: "query", type: "string" },
    order: { name: "order", description: "Ordering", required: false, in: "query", type: "string" },
    limit: { name: "limit", description: "Limiting and Pagination", required: false, in: "query", type: "string" },
    preferPost: { name: "Prefer", description: "Preference", required: false, in: "header", type: "string", enum: ["return=representation", "return=minimal", "return=none"] },
  };
  for (const [table, def] of Object.entries(definitions)) {
    parameters[`body.${table}`] = { name: table, description: table, required: false, in: "body", schema: { $ref: `#/definitions/${table}` } };
    for (const [name, prop] of Object.entries<any>(def.properties))
      parameters[`rowFilter.${table}.${name}`] = { name, required: false, in: "query", format: prop.format, type: "string" };
  }
  return {
    swagger: "2.0",
    info: { description: "", title: "standard public schema", version: "spark" },
    host: new URL(PUBLIC_URL).host,
    basePath: "/rest/v1",
    schemes: [new URL(PUBLIC_URL).protocol.replace(":", "")],
    consumes: ["application/json", "application/vnd.pgrst.object+json", "text/csv"],
    produces: ["application/json", "application/vnd.pgrst.object+json", "text/csv"],
    paths,
    definitions,
    parameters,
    externalDocs: { description: "PostgREST Documentation", url: "https://postgrest.org/en/v12/references/api.html" },
  };
}

// ---------- pg-meta REST ----------

/** Studio's `/pg/<resource>` calls, in pg-meta's JSON shapes. */
async function pgMetaRest(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const m = await current();
  const list = (k: string) => url.searchParams.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);
  const included = list("included_schemas");
  const excluded = list("excluded_schemas") ?? [];
  const inSchema = (s: string) => (!included || included.includes(s)) && !excluded.includes(s);
  const [, resource, id] = /^\/([\w-]+)(?:\/(\d+))?\/?$/.exec(path) ?? [];
  const pick = (rows: any[]) => (id ? (rows.find((r) => String(r.id) === id) ?? null) : rows);
  const withColumns = url.searchParams.get("include_columns") !== "false";
  switch (resource) {
    case "tables":
      return json(pick(m.d.tables.filter((t) => inSchema(t.schema)).map((t) => m.table(t, withColumns))));
    case "columns":
      return json(pick(m.d.tables.filter((t) => inSchema(t.schema)).flatMap((t) => t.columns.map((c) => m.column(t, c)))));
    case "views":
      return json(pick(m.d.views.filter((v) => inSchema(v.schema)).map(m.view)));
    case "schemas":
      return json(pick(m.schemas().filter((s) => inSchema(s.name))));
    case "policies":
      return json(pick(m.policies().filter((p) => inSchema(p.schema))));
    case "types":
      return json(pick(m.types().filter((t) => inSchema(t.schema))));
    case "roles":
      return json(pick((adapters.find((a) => a.name === "roles")!.run as any)()));
    case "publications":
      return json(pick((adapters.find((a) => a.name === "publications")!.run as any)()));
    case "extensions":
    case "functions":
    case "triggers":
    case "materialized-views":
    case "foreign-tables":
    case "column-privileges":
    case "table-privileges":
      return json(id ? null : []);
    case "config":
      return json([{ name: "server_version", setting: "17.0" }]);
    case "generators":
      if (path.startsWith("/generators/typescript")) return new Response(typescript(m.d, included ?? ["public"]), { headers: { "content-type": "text/plain" } });
  }
  return json({ message: `Not supported on Spark: GET /pg${path} is not served from the schema description` }, 501);
}

// ---------- HTTP ----------

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra },
  });
const errorJson = (e: unknown) => {
  if (e instanceof QueryError) {
    const { code, message, details, hint } = e.err;
    const formattedError = `ERROR:  ${code ?? ""}: ${message}${details ? `\nDETAIL:  ${details}` : ""}${hint ? `\nHINT:  ${hint}` : ""}`;
    return json({ code, message, details, hint, error: message, formattedError }, 400);
  }
  console.error(e);
  return json({ message: String((e as Error)?.message ?? e) }, 500);
};

async function proxy(req: Request, base: string, path: string) {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  const res = await fetch(`${base}${path}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(res.body, { status: res.status, headers: out });
}

async function management(req: Request, rest: string): Promise<Response> {
  // Local only, like the `supabase start` stack: any access token is accepted.
  const method = req.method;
  if (rest === "" && method === "GET") {
    return json({
      id: PROJECT_REF,
      ref: PROJECT_REF,
      name: "spark-local",
      organization_id: "local",
      region: "local",
      status: "ACTIVE_HEALTHY",
      created_at: new Date(0).toISOString(),
      database: { host: "127.0.0.1", version: "17-spark", postgres_engine: "spark", release_channel: "ga" },
    });
  }
  if (rest === "/database/query" && method === "POST") {
    const { query, parameters, read_only } = await req.json();
    const r = await runSql(query, parameters ?? [], !!read_only, "mcp");
    return json(r.rows, 201, { "x-spark-target": r.target });
  }
  if (rest === "/database/migrations" && method === "GET") {
    const ms = await sparkMigrations();
    return json(ms.map(({ version, name }) => ({ version, name })));
  }
  if (rest === "/database/migrations" && method === "POST") {
    const { name, query, version: wanted } = await req.json();
    const version = await applySchemaChange(query, name ?? "mcp", wanted);
    return json({ version, name }, 201);
  }
  if (rest.startsWith("/api-keys") && method === "GET") {
    return json([
      { name: "anon", api_key: ANON_KEY, type: "legacy", id: "anon" },
      { name: "service_role", api_key: SERVICE_KEY, type: "legacy", id: "service_role" },
    ]);
  }
  if (rest === "/types/typescript" && method === "GET") {
    const schemas = (new URL(req.url).searchParams.get("included_schemas") ?? "public").split(",").map((s) => s.trim());
    return json({ types: typescript((await current()).d, schemas) });
  }
  if (rest.startsWith("/advisors/") && method === "GET") return json({ lints: [] });
  if (rest === "/health" && method === "GET") return json([{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }]);
  return json({ message: `not implemented in the spark dev gateway: ${method} /v1/projects/{ref}${rest}` }, 501);
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS" && (p.startsWith("/pg/") || p.startsWith("/v1/") || p.startsWith("/_dev/"))) {
        return new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" },
        });
      }
      if ((p === "/rest/v1/" || p === "/rest/v1") && req.method === "GET") return json(await openApi(), 200, { "content-type": "application/openapi+json" });
      if (p.startsWith("/rest/v1") || p.startsWith("/auth/v1") || p.startsWith("/_spark/")) return await proxy(req, SPARK_URL, p);
      if (p === "/pg/query" && req.method === "POST") {
        const { query, parameters } = await req.json();
        const r = await runSql(query, parameters ?? [], false, "studio");
        return json(r.rows, 201, { "x-spark-target": r.target });
      }
      if (p.startsWith("/pg/") && req.method === "GET") return await pgMetaRest(req, p.slice(3));
      if (p.startsWith("/pg/")) return json({ message: `Not supported on Spark: ${req.method} ${p} (use POST /pg/query)` }, 501);
      if (p === "/_dev/status") return json({ projectRef: PROJECT_REF, publicUrl: PUBLIC_URL, schemaVersion: cached?.version ?? null });
      if (p === "/_dev/types/typescript" && req.method === "GET") {
        const schemas = (url.searchParams.get("included_schemas") ?? "public").split(",").map((s) => s.trim());
        return new Response(typescript((await current()).d, schemas), { headers: { "content-type": "text/plain" } });
      }
      if (p === "/_dev/sync" && req.method === "POST") {
        invalidate();
        const m = await current();
        return json({ schemaVersion: m.d.schema_version, tables: m.d.tables.length });
      }
      const mm = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(p);
      if (mm) return await management(req, mm[2] ?? "");
      if (p === "/v1/projects" && req.method === "GET") return management(req, "").then(async (r) => json([await r.json()]));
      if (p === "/v1/organizations" && req.method === "GET") return json([{ id: "local", name: "Local" }]);
      return json({ message: "not found" }, 404);
    } catch (e) {
      return errorJson(e);
    }
  },
});
console.log(`[gateway] listening on :${PORT} (spark ${SPARK_URL}; no Postgres: catalog from the schema description)`);
