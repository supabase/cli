import { Data, Effect } from "effect";
import type {
  Column,
  Constraint,
  Description,
  Enum,
  Migration,
  Row,
  Table,
  View,
} from "./Description.ts";

/** A stable synthetic oid: Studio keys tables, columns and constraints by oid. */
const oid = (key: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return 16384 + (hash % 2_000_000_000);
};

const UDT: Readonly<Record<string, string>> = {
  bigint: "int8",
  integer: "int4",
  smallint: "int2",
  boolean: "bool",
  "double precision": "float8",
  real: "float4",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "character varying": "varchar",
  character: "bpchar",
  bit: "bit",
  "bit varying": "varbit",
};

const baseType = (type: string) => type.replace(/\(.*?\)/u, "").trim();

export interface TypeInfo {
  readonly data_type: string;
  readonly format: string;
  readonly format_schema: string;
  readonly enum: Enum | undefined;
  readonly array: boolean;
  readonly base: string;
}

export const typeInfo = (description: Description, type: string): TypeInfo => {
  // Postgres names an array type `_<element>` whatever its dimensions.
  const element = type.replace(/(?:\s*\[\d*\])+$/u, "");
  const array = element !== type;
  const inner = baseType(element);
  const found = description.enums.find(
    (e) =>
      inner === `${e.schema}.${e.name}` ||
      (e.schema === "public" && inner === e.name) ||
      inner === `"${e.schema}"."${e.name}"`,
  );
  const udt = found === undefined ? (UDT[inner] ?? inner) : found.name;
  return {
    data_type: array ? "ARRAY" : found === undefined ? inner : "USER-DEFINED",
    format: array ? `_${udt}` : udt,
    format_schema: found === undefined ? "pg_catalog" : found.schema,
    enum: found,
    array,
    base: udt,
  };
};

const FK_ACTION: Readonly<Record<string, string>> = {
  "NO ACTION": "a",
  RESTRICT: "r",
  CASCADE: "c",
  "SET NULL": "n",
  "SET DEFAULT": "d",
};

const fkAction = (def: string, on: "DELETE" | "UPDATE") => {
  const action = new RegExp(
    `ON ${on} (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)`,
    "iu",
  ).exec(def)?.[1];
  return action === undefined ? "a" : (FK_ACTION[action.toUpperCase()] ?? "a");
};

const indexColumns = (def: string): ReadonlyArray<string> => {
  const list = (/USING \w+ \((.*)\)\s*(?:INCLUDE|WHERE|$)/iu.exec(def) ??
    /\((.*)\)/u.exec(def))?.[1];
  return list === undefined ? [] : list.split(",").map((s) => s.trim().replace(/^"|"$/gu, ""));
};

interface Named {
  readonly schema: string;
  readonly name: string;
}

interface ForeignKey {
  readonly table: Table;
  readonly constraint: Constraint;
  readonly references: NonNullable<Constraint["references"]>;
}

const POLICY_COMMAND: Readonly<Record<string, string>> = {
  r: "SELECT",
  a: "INSERT",
  w: "UPDATE",
  d: "DELETE",
  "*": "ALL",
};

/** pg-meta object shapes for one description. */
export const makeModel = (description: Description) => {
  const tableId = (t: Named) => oid(`${t.schema}.${t.name}`);
  const findTable = (schema: string, name: string) =>
    description.tables.find((t) => t.schema === schema && t.name === name);
  const column = (t: Table, c: Column) => {
    const info = typeInfo(description, c.type);
    const unique = t.constraints.some(
      (k) => k.type === "u" && k.columns.length === 1 && k.columns[0] === c.name,
    );
    const check = t.constraints.find(
      (k) => k.type === "c" && k.columns.length === 1 && k.columns[0] === c.name,
    );
    return {
      table_id: tableId(t),
      schema: t.schema,
      table: t.name,
      id: `${tableId(t)}.${c.position}`,
      ordinal_position: c.position,
      name: c.name,
      default_value: c.identity === null ? c.default : null,
      data_type: info.data_type,
      format: info.format,
      format_schema: info.format_schema,
      is_identity: c.identity !== null,
      identity_generation:
        c.identity === "a"
          ? ("ALWAYS" as const)
          : c.identity === "d"
            ? ("BY DEFAULT" as const)
            : null,
      is_generated: c.generated !== null && c.generated !== "",
      is_nullable: !c.not_null,
      is_updatable: true,
      is_unique: unique,
      check: check === undefined ? null : check.def.slice(7, -1),
      enums: info.enum?.labels ?? [],
      comment: c.comment,
    };
  };
  const foreignKeys: ReadonlyArray<ForeignKey> = description.tables.flatMap((table) =>
    table.constraints.flatMap((constraint) =>
      constraint.type === "f" && constraint.references !== null
        ? [{ table, constraint, references: constraint.references }]
        : [],
    ),
  );
  const relationship = ({ table, constraint, references }: ForeignKey) => {
    const target = findTable(references.schema, references.table);
    return {
      id: oid(`${table.schema}.${table.name}.${constraint.name}`),
      constraint_name: constraint.name,
      deletion_action: fkAction(constraint.def, "DELETE"),
      update_action: fkAction(constraint.def, "UPDATE"),
      source_id: tableId(table),
      source_schema: table.schema,
      source_table_name: table.name,
      source_column_name: constraint.columns[0],
      source_columns: constraint.columns,
      target_id:
        target === undefined ? oid(`${references.schema}.${references.table}`) : tableId(target),
      target_table_schema: references.schema,
      target_table_name: references.table,
      target_column_name: references.columns[0],
      target_columns: references.columns,
    };
  };
  const relationshipsOf = (t: Table) =>
    foreignKeys
      .filter(
        ({ table, references }) =>
          (table.schema === t.schema && table.name === t.name) ||
          (references.schema === t.schema && references.table === t.name),
      )
      .map(relationship);
  const primaryKeys = (t: Table) =>
    (t.constraints.find((k) => k.type === "p")?.columns ?? []).map((name) => ({
      schema: t.schema,
      table_name: t.name,
      name,
      table_id: tableId(t),
    }));
  const table = (t: Table, withColumns = true) => ({
    id: tableId(t),
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
  const view = (v: View) => ({
    id: tableId(v),
    schema: v.schema,
    name: v.name,
    is_updatable: false,
    comment: v.comment,
    columns: [],
  });
  const policies = () =>
    description.tables.flatMap((t) =>
      t.policies.map((p) => ({
        id: oid(`${t.schema}.${t.name}.policy.${p.name}`),
        schema: t.schema,
        table: t.name,
        table_id: tableId(t),
        name: p.name,
        action: p.permissive ? "PERMISSIVE" : "RESTRICTIVE",
        roles: p.roles.length > 0 ? p.roles : ["public"],
        command: POLICY_COMMAND[p.cmd] ?? p.cmd,
        definition: p.using,
        check: p.check,
      })),
    );
  const types = () =>
    description.enums.map((e) => ({
      id: oid(`type.${e.schema}.${e.name}`),
      name: e.name,
      schema: e.schema,
      format: e.schema === "public" ? e.name : `${e.schema}.${e.name}`,
      enums: e.labels,
      attributes: [],
      comment: e.comment,
    }));
  const schemaNames = () => [
    ...new Set([
      ...description.schemas.map((s) => s.name),
      ...description.managed_schemas,
      "public",
    ]),
  ];
  const schemas = () =>
    schemaNames().map((name) => ({
      id: oid(`schema.${name}`),
      name,
      owner: description.managed_schemas.includes(name) ? "supabase_admin" : "postgres",
      comment: description.schemas.find((s) => s.name === name)?.comment ?? null,
    }));
  const tableById = (id: number) => description.tables.find((t) => tableId(t) === id);
  const viewById = (id: number) => description.views.find((v) => tableId(v) === id);
  return {
    description,
    tableId,
    findTable,
    column,
    table,
    view,
    relationship,
    foreignKeys,
    policies,
    types,
    schemas,
    schemaNames,
    tableById,
    viewById,
  };
};

export type Model = ReturnType<typeof makeModel>;

const ROLES = [
  "postgres",
  "anon",
  "authenticated",
  "service_role",
  "supabase_admin",
  "authenticator",
  "supabase_auth_admin",
];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : (JSON.stringify(value) ?? "");

/** Strings in `in ('a','b')`, `= 'a'` or `in ($1)` after `marker`, with `$n` resolved from the parameters. */
const listAfter = (
  sql: string,
  marker: RegExp,
  params: ReadonlyArray<unknown>,
): ReadonlyArray<string> | undefined => {
  const list = (new RegExp(marker.source + String.raw`\s*(?:in|IN)\s*\(([^)]*)\)`, "iu").exec(
    sql,
  ) ?? new RegExp(marker.source + String.raw`\s*=\s*('[^']*'|\$\d+)`, "iu").exec(sql))?.[1];
  if (list === undefined) return undefined;
  return list.split(",").flatMap((raw) => {
    const item = raw.trim();
    const param = /^\$(\d+)$/u.exec(item)?.[1];
    if (param !== undefined) {
      const value = params[Number(param) - 1];
      if (Array.isArray(value)) return value.map((item: unknown) => textOf(item));
      return textOf(value)
        .split(",")
        .map((x) => x.trim());
    }
    return [item.replace(/^'|'$/gu, "").replace(/''/gu, "'")];
  });
};

const notIn = (sql: string, marker: RegExp): ReadonlyArray<string> => {
  const list = new RegExp(marker.source + String.raw`\s*not\s+in\s*\(([^)]*)\)`, "iu").exec(
    sql,
  )?.[1];
  return list === undefined ? [] : list.split(",").map((s) => s.trim().replace(/^'|'$/gu, ""));
};

const oidFilter = (sql: string): number | undefined => {
  const id = /\b(?:c\.oid|oid|tables\.id|id)\s*=\s*(\d+)/iu.exec(sql)?.[1];
  return id === undefined ? undefined : Number(id);
};

/** `relname = 'x' and nspname = 'y'` subselects pg-meta uses to pin one table. */
const namedTable = (sql: string): Named | undefined => {
  const match =
    /relname\s*=\s*'([^']+)'\s+and\s+\w+\.nspname\s*=\s*'([^']+)'/iu.exec(sql) ??
    /\bname\s*=\s*'([^']+)'\s+and\s+schema\s*=\s*'([^']+)'/iu.exec(sql);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { name: match[1], schema: match[2] };
};

const quoteIdent = (s: string): string =>
  /^[a-z_][a-z0-9_]*$/u.test(s) ? s : `"${s.replace(/"/gu, '""')}"`;

/** What one catalog adapter needs to answer a query. */
interface AdapterContext<E> {
  readonly model: Model;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  /** Runs a read-only query on Spark. */
  readonly spark: (query: string) => Effect.Effect<ReadonlyArray<Row>, E>;
  readonly migrations: Effect.Effect<ReadonlyArray<Migration>, E>;
  readonly boolLiterals: (sql: string) => string;
}

/** A query shape the adapter recognizes could not be parsed. */
export class AdapterShapeError extends Data.TaggedError("AdapterShapeError")<{
  readonly message: string;
}> {}

export interface Adapter {
  readonly name: string;
  readonly match: (sql: string) => boolean;
  readonly run: <E>(
    context: AdapterContext<E>,
  ) => Effect.Effect<ReadonlyArray<unknown>, E | AdapterShapeError>;
}

const has =
  (...needles: ReadonlyArray<string | RegExp>) =>
  (sql: string): boolean => {
    const lower = sql.toLowerCase();
    return needles.every((needle) =>
      typeof needle === "string" ? lower.includes(needle.toLowerCase()) : needle.test(sql),
    );
  };

const pure =
  (answer: <E>(context: AdapterContext<E>) => ReadonlyArray<unknown>) =>
  <E>(context: AdapterContext<E>) =>
    Effect.sync(() => answer(context));

const shape = (message: string) => Effect.fail(new AdapterShapeError({ message }));

/** Tables, with or without columns, filtered as the query's tail filters them. */
const tablesQuery = <E>({ model, sql, params, spark }: AdapterContext<E>) =>
  Effect.gen(function* () {
    const from = sql.lastIndexOf("from tables");
    const tail = sql.slice(from >= 0 ? from : 0);
    const includeColumns = /\)\s*as\s+columns\s+from\s+tables/iu.test(sql);
    let tables = model.description.tables;
    const schemas = listAfter(tail, /\bschema/u, params) ?? listAfter(sql, /nc\.nspname/u, params);
    if (schemas !== undefined) tables = tables.filter((t) => schemas.includes(t.schema));
    const excluded = notIn(tail, /\bschema/u);
    if (excluded.length > 0) tables = tables.filter((t) => !excluded.includes(t.schema));
    const named = namedTable(sql);
    if (named !== undefined)
      tables = tables.filter((t) => t.name === named.name && t.schema === named.schema);
    const id = /tables\.id\s*=\s*(\d+)|\bc\.oid\s*=\s*(\d+)/iu.exec(sql);
    if (id !== null) tables = tables.filter((t) => model.tableId(t) === Number(id[1] ?? id[2]));
    const out = tables.map((t) => model.table(t, includeColumns)).sort((a, b) => a.id - b.id);
    // Row counts stand in for pg_stat live tuples, which MCP list_tables shows; managed tables keep 0.
    return yield* Effect.forEach(
      out,
      (t) =>
        model.description.managed_schemas.includes(t.schema)
          ? Effect.succeed(t)
          : spark(`select count(*) as n from ${quoteIdent(t.schema)}.${quoteIdent(t.name)}`).pipe(
              Effect.orElseSucceed((): ReadonlyArray<Row> => []),
              Effect.map((rows) => ({ ...t, live_rows_estimate: Number(rows[0]?.n ?? 0) })),
            ),
      { concurrency: "unbounded" },
    );
  });

const entityDefinition = <E>({ model, sql }: AdapterContext<E>) => {
  const id = oidFilter(sql);
  if (id === undefined) return [];
  const target = model.tableById(id);
  if (target !== undefined) {
    const t = model.table(target);
    const unique_indexes = target.indexes
      .filter(
        (i) =>
          i.unique &&
          !(
            i.constraint !== null &&
            target.constraints.find((k) => k.name === i.constraint)?.type === "p"
          ),
      )
      .map((i) => ({
        schema: target.schema,
        table_name: target.name,
        table_id: t.id,
        columns: indexColumns(i.def),
      }));
    return [{ entity: { entity_type: "r", ...t, unique_indexes, relationships: t.relationships } }];
  }
  const view = model.viewById(id);
  return view === undefined ? [] : [{ entity: { entity_type: "v", ...model.view(view) } }];
};

const entities = <E>({ model, sql }: AdapterContext<E>) => {
  const schemas = listAfter(sql, /nc\.nspname/u, []) ?? ["public"];
  const search = /relname\s+ilike\s+'%?([^'%]*)%?'/iu.exec(sql)?.[1]?.toLowerCase();
  const rows = [
    ...model.description.tables
      .filter((t) => schemas.includes(t.schema))
      .map((t) => ({
        id: model.tableId(t),
        schema: t.schema,
        name: t.name,
        type: "r",
        comment: t.comment,
        rls_enabled: t.rls_enabled,
      })),
    ...model.description.views
      .filter((v) => schemas.includes(v.schema))
      .map((v) => ({
        id: model.tableId(v),
        schema: v.schema,
        name: v.name,
        type: "v",
        comment: v.comment,
        rls_enabled: false,
      })),
  ]
    .filter((r) => search === undefined || search === "" || r.name.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));
  const limit = Number(/\blimit\s+(\d+)/iu.exec(sql)?.[1] ?? 100);
  const offset = Number(/\boffset\s+(\d+)/iu.exec(sql)?.[1] ?? 0);
  return [{ data: { entities: rows.slice(offset, offset + limit), count: rows.length } }];
};

/** Table editor rows: `with _base_query as (<select>) select <truncated columns> from _base_query`. */
const tableRows = <E>(context: AdapterContext<E>) =>
  Effect.gen(function* () {
    const match =
      /with _base_query as \(([\s\S]*)\)\s*select\s+([\s\S]*?)\s+from _base_query/iu.exec(
        context.sql,
      );
    if (match?.[1] === undefined || match[2] === undefined)
      return yield* shape("table editor query shape changed");
    const inner = context.boolLiterals(match[1]);
    const rows = yield* context.spark(inner);
    const truncated = [
      ...match[2].matchAll(/when octet_length\((\w+|"[^"]+")::text\) > (\d+)/giu),
    ].map((x) => [(x[1] ?? "").replace(/"/gu, ""), Number(x[2])] as const);
    return rows.map((row) => {
      const out: Row = { ...row };
      for (const [column, limit] of truncated) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        out[column] = text.length > limit ? `${text.slice(0, limit)}...` : text;
      }
      return out;
    });
  });

const countQuery = <E>(context: AdapterContext<E>) =>
  Effect.gen(function* () {
    const from = /else\s*\(select count\(\*\) from ([\s\S]*?)\)\s*end\s+as\s+count/iu.exec(
      context.sql,
    )?.[1];
    if (from === undefined) return yield* shape("count query shape changed");
    const rows = yield* context.spark(
      `select count(*) as count from ${context.boolLiterals(from)}`,
    );
    return [{ count: Number(rows[0]?.count ?? 0), is_estimate: false }];
  });

const authUsers = <E>(context: AdapterContext<E>) =>
  Effect.gen(function* () {
    const inner = /users_data as \(([\s\S]*?)\)\s*select/iu.exec(context.sql)?.[1];
    if (inner === undefined) return yield* shape("auth users query shape changed");
    const users = yield* context.spark(inner);
    const identities = yield* context.spark("select user_id, provider from auth.identities");
    return users.map((user) => ({
      ...user,
      providers: [
        ...new Set(identities.filter((i) => i.user_id === user.id).map((i) => String(i.provider))),
      ],
    }));
  });

const migrationsQuery = <E>(context: AdapterContext<E>) =>
  context.migrations.pipe(
    Effect.map((migrations) =>
      migrations
        .map((m) => ({ version: m.version, name: m.name, statements: m.statements }))
        .sort((a, b) => (a.version < b.version ? 1 : -1)),
    ),
  );

const sqlEditorTables = <E>({ model, sql }: AdapterContext<E>) => {
  const schemas = listAfter(sql, /where\s+schemaname/u, []);
  const relations = [
    ...model.description.tables.map((t) => ({
      t,
      is_table: true,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, position: c.position })),
    })),
    ...model.description.views.map((v) => ({ t: v, is_table: false, columns: [] })),
  ].filter((r) => schemas === undefined || schemas.includes(r.t.schema));
  return relations.map(({ t, is_table, columns }) => ({
    schemaname: t.schema,
    tablename: t.name,
    quoted_name: `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`,
    is_table,
    columns:
      columns.length > 0
        ? columns.map((c) => ({
            attrelid: model.tableId(t),
            attname: c.name,
            data_type: c.type,
            attnum: c.position,
            attisdropped: false,
          }))
        : [null],
  }));
};

const KEYWORDS =
  "all and any array as asc between by case cast check collate column constraint create cross default delete desc distinct do else end except false fetch for foreign from full grant group having ilike in inner insert intersect into is join lateral left like limit not null offset on only or order outer primary references returning right select set table then to true union unique update using values when where window with".split(
    " ",
  );

const SETTINGS: Readonly<Record<string, string>> = {
  max_connections: "100",
  server_version_num: "170000",
  server_version: "17.0",
  search_path: '"$user", public, extensions',
  "pgrst.db_schemas": "public,graphql_public",
  statement_timeout: "0",
  timezone: "UTC",
};

/** Roles Studio lists; Spark has no role catalog. */
export const roleRows = () =>
  ROLES.map((name) => ({
    id: oid(`role.${name}`),
    name,
    isSuperuser: name === "postgres" || name === "supabase_admin",
    canCreateDb: name === "postgres",
    canCreateRole: name === "postgres",
    inheritRole: true,
    canLogin: ["postgres", "authenticator", "supabase_admin", "supabase_auth_admin"].includes(name),
    isReplicationRole: false,
    canBypassRls: ["postgres", "service_role", "supabase_admin"].includes(name),
    activeConnections: 0,
    connectionLimit: 100,
    validUntil: null,
    config: {},
  }));

/** The realtime publication Studio expects to exist. */
export const publicationRows = () => [
  {
    id: oid("pub.supabase_realtime"),
    name: "supabase_realtime",
    owner: "postgres",
    publish_insert: true,
    publish_update: true,
    publish_delete: true,
    publish_truncate: true,
    tables: [],
  },
];

/** Each catalog query Studio and the MCP server send, matched on distinctive markers. */
export const adapters: ReadonlyArray<Adapter> = [
  {
    name: "lints",
    match: has("pg_stat_statements.track", "pgrst.db_schemas"),
    run: pure(() => []),
  },
  { name: "migrations", match: has("supabase.studio_migrations"), run: migrationsQuery },
  { name: "count", match: has("pg_temp.count_estimate"), run: countQuery },
  {
    name: "table-rows-explain",
    match: has(/^\s*explain\s+with _base_query as/iu),
    run: pure(() => [{ "QUERY PLAN": "Limit  (cost=0.00..1.00 rows=100 width=0)" }]),
  },
  { name: "table-rows", match: has(/^\s*with _base_query as \(/iu), run: tableRows },
  {
    name: "entity-definition",
    match: has("base_table_info", "'entity_type'"),
    run: pure(entityDefinition),
  },
  { name: "entities", match: has("with records as", "'entities'"), run: pure(entities) },
  {
    name: "views",
    match: has(/with\s+views\s+as/iu, "pg_relation_is_updatable"),
    run: pure(({ model, sql }) => {
      const schemas = listAfter(sql.slice(sql.lastIndexOf("from views")), /\bschema/u, []);
      return model.description.views
        .filter((v) => schemas === undefined || schemas.includes(v.schema))
        .map(model.view);
    }),
  },
  {
    name: "materialized-views",
    match: has(/with\s+materialized_views\s+as/iu),
    run: pure(() => []),
  },
  { name: "foreign-tables", match: has(/with\s+foreign_tables\s+as/iu), run: pure(() => []) },
  {
    name: "tables",
    match: (s) => /with\s+(tables\s+as|page\s+as)/iu.test(s) && s.includes("primary_keys"),
    run: tablesQuery,
  },
  {
    name: "api-docs-table-grants",
    match: has("table_grants", "total_count"),
    run: pure(({ model }) => {
      const tables = model.description.tables.filter((t) => !t.managed);
      return [
        {
          total_count: tables.length,
          tables: tables.map((t) => ({
            id: model.tableId(t),
            schema: t.schema,
            name: t.name,
            status: "granted",
          })),
        },
      ];
    }),
  },
  {
    name: "api-docs-function-grants",
    match: has("function_grants", "total_count"),
    run: pure(() => [{ total_count: 0, functions: [] }]),
  },
  {
    name: "table-privileges",
    match: has("with table_privileges as", "aclexplode", "privilege_type"),
    run: pure(({ model, sql }) => {
      const schemas = listAfter(sql, /nc\.nspname/u, []) ?? model.schemaNames();
      return model.description.tables
        .filter((t) => schemas.includes(t.schema))
        .map((t) => ({
          relation_id: model.tableId(t),
          schema: t.schema,
          name: t.name,
          kind: "table",
          privileges: ROLES.slice(0, 4).flatMap((grantee) =>
            PRIVILEGES.map((privilege_type) => ({
              grantor: "postgres",
              grantee,
              privilege_type,
              is_grantable: false,
            })),
          ),
        }));
    }),
  },
  {
    name: "schemas",
    match: has("information_schema.schemata", "pg_namespace"),
    run: pure(({ model }) => model.schemas()),
  },
  { name: "foreign-servers", match: has("pg_foreign_server", "srvoptions"), run: pure(() => []) },
  {
    name: "publications",
    match: has("pg_publication", "publish_insert"),
    run: pure(publicationRows),
  },
  { name: "extensions", match: has("pg_available_extensions"), run: pure(() => []) },
  {
    name: "policies",
    match: has("pg_policy", "polname"),
    run: pure(({ model, sql, params }) => {
      const schemas = listAfter(sql.slice(sql.lastIndexOf("from policies")), /\bschema/u, params);
      const tableId = /table_id\s*=\s*(\d+)/iu.exec(sql)?.[1];
      return model
        .policies()
        .filter(
          (p) =>
            (schemas === undefined || schemas.includes(p.schema)) &&
            (tableId === undefined || p.table_id === Number(tableId)),
        );
    }),
  },
  {
    name: "foreign-keys",
    match: has("con.confdeltype as deletion_action", "source_columns"),
    run: pure(({ model, sql }) => {
      const schemas = listAfter(sql, /nsp\.nspname/u, []);
      return model.foreignKeys
        .filter(({ table }) => schemas === undefined || schemas.includes(table.schema))
        .map((fk) => {
          const r = model.relationship(fk);
          return {
            id: r.id,
            constraint_name: r.constraint_name,
            deletion_action: r.deletion_action,
            update_action: r.update_action,
            source_id: r.source_id,
            source_schema: r.source_schema,
            source_table: r.source_table_name,
            source_columns: r.source_columns,
            target_id: r.target_id,
            target_schema: r.target_table_schema,
            target_table: r.target_table_name,
            target_columns: r.target_columns,
          };
        });
    }),
  },
  {
    name: "types",
    match: has("pg_type", "pg_enum", "typrelid"),
    run: pure(({ model, sql }) => {
      const schemas = listAfter(sql, /n\.nspname/u, []);
      return model.types().filter((t) => schemas === undefined || schemas.includes(t.schema));
    }),
  },
  {
    name: "table-constraints",
    match: has("with table_info as", "con.contype as type"),
    run: pure(({ model, sql }) => {
      const t = model.tableById(oidFilter(sql) ?? -1);
      return t === undefined
        ? []
        : t.constraints.map((k) => ({
            id: oid(`${t.schema}.${t.name}.${k.name}`),
            name: k.name,
            type: k.type,
          }));
    }),
  },
  {
    name: "default-privileges",
    match: has("pg_default_acl", "grant_count"),
    run: pure(() => [{ grant_count: 3 }]),
  },
  { name: "event-triggers", match: has("pg_event_trigger"), run: pure(() => []) },
  { name: "functions", match: has(/with\s+f\s+as/iu, "arg_modes"), run: pure(() => []) },
  { name: "functions-pg-meta", match: has("pg_proc", "prosrc", "proname"), run: pure(() => []) },
  {
    name: "triggers",
    match: has("pg_trigger", "information_schema.triggers"),
    run: pure(() => []),
  },
  {
    name: "roles",
    match: has("pg_roles", "rolcanlogin", "activeConnections"),
    run: pure(roleRows),
  },
  {
    name: "indexes",
    match: has("pg_get_indexdef(idx.indexrelid)", "string_agg"),
    run: pure(({ model, sql }) => {
      const schemas = listAfter(sql, /n\.nspname/u, []);
      return model.description.tables
        .filter((t) => schemas === undefined || schemas.includes(t.schema))
        .flatMap((t) =>
          t.indexes.map((i) => ({
            schema: t.schema,
            table: t.name,
            name: i.name,
            definition: i.def,
            columns: indexColumns(i.def).join(", "),
          })),
        );
    }),
  },
  {
    name: "sql-editor-tables",
    match: has("quoted_name", "is_table", "json_agg(a)"),
    run: pure(sqlEditorTables),
  },
  {
    name: "auth-indexes",
    match: has("indisvalid as is_valid", "indisready"),
    run: pure(({ sql }) =>
      [...(/relname IN \(([^)]*)\)/iu.exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/gu)].map((x) => ({
        index_name: x[1],
        is_valid: true,
        is_ready: true,
      })),
    ),
  },
  {
    name: "auth-index-worker",
    match: has("pg_locks", "auth_index_worker"),
    run: pure(() => [{ is_in_progress: false }]),
  },
  { name: "auth-users", match: has("users_data as", "auth.identities"), run: authUsers },
  {
    name: "keywords",
    match: has("pg_get_keywords"),
    run: pure(() => KEYWORDS.map((word) => ({ word }))),
  },
  {
    name: "show",
    match: has(/^\s*show\s+\w+\s*;?\s*$/iu),
    run: pure(({ sql }) => {
      const key = (/show\s+(\w+)/iu.exec(sql)?.[1] ?? "").toLowerCase();
      return [{ [key]: SETTINGS[key] ?? "" }];
    }),
  },
  {
    name: "current-setting",
    match: has(
      /^\s*select\s+current_setting\s*\(\s*'[^']+'\s*(,\s*\w+\s*)?\)(\s+as\s+\w+)?\s*;?\s*$/iu,
    ),
    run: pure(({ sql }) => {
      const key = (/current_setting\s*\(\s*'([^']+)'/iu.exec(sql)?.[1] ?? "").toLowerCase();
      const alias = /\bas\s+(\w+)/iu.exec(sql)?.[1] ?? "current_setting";
      return [{ [alias]: SETTINGS[key] ?? null }];
    }),
  },
];
