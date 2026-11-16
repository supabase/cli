# Spark schema description (PoC contract)

Every tool that needs to know the schema (pg-delta, Studio's pg-meta endpoints, MCP, typegen, OpenAPI) reads this
JSON. It is built from spark's live `turso_pg` catalog, never from migration history, and nothing runs on Postgres.
Both sides of a pg-delta diff come from spark (live project, scratch load of declarative files), so the text forms
only need to be stable across spark, not identical to Postgres. They follow Postgres' own rendering where spark can
(`format_type`, `pg_get_expr`, `pg_get_constraintdef`, `pg_get_indexdef`), so the DDL pg-delta renders from them runs on
spark and reads naturally.

## Endpoints (service_role key, on spark's admin API)

| Endpoint | Does |
|---|---|
| `GET /_spark/v1/schema` | The description of the project database. |
| `GET /_spark/v1/schema/version` | `{ "schema_version": "..." }` only; cheap, for cache keys. |
| `POST /_spark/v1/scratch` | Loads SQL into a throwaway in-memory database (spark base + optionally the project's applied migrations), returns per-statement statuses and the resulting description, then discards it. |
| `POST /_spark/v1/migrations?dry_run=1` | Runs a migration through the guard, rewrites and fold, rolls back, returns per-statement statuses. |

### `POST /_spark/v1/scratch`

```jsonc
{
  "base": "empty" | "current",          // current = replay the project's applied migrations first
  "files": [{ "name": "schemas/todos.sql", "sql": "..." }],
  "order": "as_given" | "retry"         // retry: defer failing statements and retry until no progress (declarative files are unordered)
}
```

Response: `{ "statuses": [Status], "schema": Description }`. HTTP 200 even when some statements fail; the caller decides.

### Status

```jsonc
{ "file": "schemas/todos.sql", "index": 3, "line": 12, "kind": "CreateFunctionStmt",
  "status": "ok" | "rewritten" | "ignored" | "unsupported" | "error",
  "message": "identity column runs as serial" }
```

- `rewritten`: spark runs a different but equivalent statement (identity → serial, ADD CONSTRAINT folded into CREATE TABLE).
- `ignored`: accepted and dropped (GRANT, REVOKE, ALTER DEFAULT PRIVILEGES, COMMENT if not stored, SET).
- `unsupported`: spark cannot run it (functions, triggers, extensions, ...). Never applied anywhere.

## Description

```jsonc
{
  "schema_version": "opaque string; changes after any DDL",
  "managed_schemas": ["auth", "extensions", "supabase_migrations", ...],  // spark/Supabase-owned: reference only
  "schemas": [{ "name": "public", "comment": null }],                     // user schemas
  "enums":  [{ "schema": "public", "name": "status", "labels": ["todo", "done"], "comment": null }],
  "tables": [{
    "schema": "public", "name": "todos", "managed": false,
    "rls_enabled": true, "rls_forced": false, "comment": null,
    "columns": [{
      "name": "id", "position": 1,
      "type": "bigint",                 // format_type form: text, integer, timestamp with time zone, text[], public.status
      "not_null": true,
      "default": null,                   // pg_get_expr form: now(), 'x'::text, gen_random_uuid()
      "identity": "d",                   // "a" always | "d" by default | null (as declared; spark runs it as serial)
      "generated": null,                 // stored generated expression or null
      "comment": null
    }],
    "constraints": [{
      "name": "todos_pkey", "type": "p",  // p | u | f | c
      "def": "PRIMARY KEY (id)",          // pg_get_constraintdef form
      "columns": ["id"],
      "references": null                  // f: { "schema": "auth", "table": "users", "columns": ["id"] }
    }],
    "indexes": [{
      "name": "todos_user_id_idx",
      "def": "CREATE INDEX todos_user_id_idx ON public.todos USING btree (user_id)",  // pg_get_indexdef form
      "unique": false,
      "constraint": null                  // name of the p/u constraint it backs, if any
    }],
    "policies": [{
      "name": "own todos", "cmd": "*",    // r select | a insert | w update | d delete | * all
      "permissive": true, "roles": ["authenticated"],
      "using": "(auth.uid() = user_id)", "check": null
    }]
  }],
  "views": [{ "schema": "public", "name": "open_todos", "def": " SELECT ...", "depends_on": [{ "schema": "public", "name": "todos" }], "comment": null }]
}
```

Managed tables (for example `auth.users`) are listed with `"managed": true` so foreign keys and policies can point at
them; consumers treat them as reference only. Spark's internal objects (`__spark_*`, `__turso_internal_*`,
`sqlite_*`) never appear.
