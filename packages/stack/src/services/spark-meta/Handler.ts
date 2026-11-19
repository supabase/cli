import { Clock, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { type SparkAdmin, SparkQueryError, type SparkAdminError } from "./Admin.ts";
import {
  adapters,
  type AdapterShapeError,
  makeModel,
  type Model,
  publicationRows,
  roleRows,
} from "./Catalog.ts";
import { openApi } from "./OpenApi.ts";
import {
  boolLiterals,
  coerceRows,
  fingerprint,
  foldConstraints,
  isDdl,
  isGrantDo,
  isSession,
  isTransactionControl,
  oneLine,
  rewriteEditorWrite,
  splitSql,
  stripComments,
  words,
} from "./Sql.ts";
import { renderDump } from "./Dump.ts";
import { type SparkTypegenError, typescript } from "./Typegen.ts";

export interface SparkMetaSettings {
  readonly projectRef: string;
  readonly publicUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  /** Where schema changes made through Studio or MCP are written as migration files. */
  readonly migrationsDir: string;
  /** JSON lines of SQL Spark could not run, for finding adapter gaps. */
  readonly gapsFile: string;
}

interface Routed {
  readonly rows: ReadonlyArray<unknown>;
  readonly target: string;
}

const QueryBody = Schema.Struct({
  query: Schema.String,
  parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  read_only: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

const MigrationBody = Schema.Struct({
  query: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const corsHeaders = { "access-control-allow-origin": "*" };

const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...corsHeaders, ...headers } });

const rejected = (code: string, message: string, hint?: string) =>
  new SparkQueryError({ code, message, status: 400, ...(hint === undefined ? {} : { hint }) });

const errorResponse = (error: SparkAdminError | AdapterShapeError | SparkTypegenError) => {
  if (error._tag !== "SparkQueryError") return json({ message: error.message }, 500);
  const { code, message, details, hint } = error;
  const formattedError = `ERROR:  ${code ?? ""}: ${message}${details === undefined ? "" : `\nDETAIL:  ${details}`}${hint === undefined ? "" : `\nHINT:  ${hint}`}`;
  return json(
    {
      code: code ?? null,
      message,
      details: details ?? null,
      hint: hint ?? null,
      error: message,
      formattedError,
    },
    400,
  );
};

const schemaList = (value: string | null | undefined) =>
  value === null || value === undefined
    ? undefined
    : value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");

const migrationTimestamp = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\D/gu, "").slice(0, 14);

const GapRecord = Schema.Struct({
  at: Schema.String,
  source: Schema.String,
  catalog: Schema.Boolean,
  fingerprint: Schema.String,
  error: Schema.String,
  query: Schema.String,
});
const encodeGapRecord = Schema.encodeEffect(Schema.fromJsonString(GapRecord));

/** Answers Studio's pg-meta calls and the Management API subset MCP uses from Spark's description. */
export const makeSparkMetaHandler = Effect.fn("SparkMeta.make")(function* (
  admin: SparkAdmin,
  settings: SparkMetaSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cached = yield* Ref.make<{ readonly version: string; readonly model: Model } | undefined>(
    undefined,
  );

  /** The model for Spark's current schema version; the full description only when it changed. */
  const current = Effect.gen(function* () {
    const { schema_version } = yield* admin.schemaVersion;
    const hit = yield* Ref.get(cached);
    if (hit?.version === schema_version) return hit.model;
    const description = yield* admin.schema;
    const model = makeModel(description);
    yield* Ref.set(cached, { version: description.schema_version, model });
    return model;
  }).pipe(Effect.withSpan("SparkMeta.description"));

  const invalidate = Ref.set(cached, undefined);

  const logGap = Effect.fn("SparkMeta.logGap")(
    function* (
      source: string,
      query: string,
      error: { readonly code?: string; readonly message: string },
      catalog: boolean,
    ) {
      const at = DateTime.formatIso(yield* DateTime.now);
      const record = yield* encodeGapRecord({
        at,
        source,
        catalog,
        fingerprint: fingerprint(query),
        error: `${error.code ?? ""} ${error.message}`,
        query: oneLine(query, 300),
      });
      const line = `${record}\n`;
      yield* fs.makeDirectory(path.dirname(settings.gapsFile), { recursive: true });
      yield* fs.writeFileString(settings.gapsFile, line, { flag: "a" });
    },
    (effect) => Effect.ignore(effect),
  );

  /** Records a schema change as `supabase migration fetch` would, unless the version exists. */
  const writeMigrationFile = Effect.fn("SparkMeta.writeMigrationFile")(function* (
    version: string,
    name: string,
    sql: string,
  ) {
    yield* fs.makeDirectory(settings.migrationsDir, { recursive: true });
    const existing = yield* fs.readDirectory(settings.migrationsDir);
    if (existing.some((file) => file.startsWith(`${version}_`))) return;
    const file = `${version}_${name.replace(/[^A-Za-z0-9_]+/gu, "_")}.sql`;
    yield* fs.writeFileString(path.join(settings.migrationsDir, file), `${sql.trim()}\n`);
  });

  const prepareStatements = (sql: string) => {
    // A Spark migration is atomic already, and Spark refuses transaction control inside scripts.
    const statements = splitSql(sql).filter((s) => !isTransactionControl(s) && !isGrantDo(s));
    return foldConstraints(statements);
  };

  /** Runs a migration in a rolled-back transaction on the current database and reports each statement. */
  const dryRunSchemaChange = Effect.fn("SparkMeta.dryRunSchemaChange")(function* (
    sql: string,
    name: string,
    wanted?: string,
  ) {
    const folded = prepareStatements(sql);
    if ("rejected" in folded)
      return [
        {
          index: 0,
          kind: "constraint",
          status: "error",
          message: folded.rejected.message,
          statement: oneLine(sql, 200),
        },
      ];
    const forSpark = folded.statements;
    yield* Effect.annotateCurrentSpan({ "spark.statements": forSpark.length });
    if (forSpark.length === 0) return [];
    const version = wanted ?? migrationTimestamp(yield* Clock.currentTimeMillis);
    const { statuses } = yield* admin.dryRunMigration(version, name, `${forSpark.join(";\n")};`);
    return statuses.map((s) => ({ ...s, statement: oneLine(forSpark[s.index] ?? "", 200) }));
  });

  /** Applies a schema change as a Spark migration after a dry run on a scratch copy. */
  const applySchemaChange = Effect.fn("SparkMeta.applySchemaChange")(function* (
    sql: string,
    name: string,
    wanted?: string,
  ) {
    const folded = prepareStatements(sql);
    if ("rejected" in folded) {
      const { code, message, hint } = folded.rejected;
      return yield* rejected(code, message, hint);
    }
    const forSpark = folded.statements;
    yield* Effect.annotateCurrentSpan({ "spark.statements": forSpark.length });
    // Only Studio's grant loops: nothing for Spark, and no migration.
    if (forSpark.length === 0) return undefined;
    const script = `${forSpark.join(";\n")};`;
    const latest =
      (yield* admin.migrations)
        .map((m) => m.version)
        .sort()
        .at(-1) ?? "0";
    const numericLatest = /^\d+$/u.test(latest);
    let version = migrationTimestamp(yield* Clock.currentTimeMillis);
    if (wanted !== undefined) {
      if (numericLatest && BigInt(wanted) <= BigInt(latest))
        return yield* rejected(
          "22023",
          `migration version ${wanted} is not after the latest applied version ${latest}`,
        );
      version = wanted;
    } else if (numericLatest && BigInt(version) <= BigInt(latest))
      version = (BigInt(latest) + 1n).toString();
    const dry = yield* admin.scratch([{ name: `${version}_${name}.sql`, sql: script }]);
    const bad = dry.statuses.filter((s) => s.status === "unsupported" || s.status === "error");
    const first = bad[0];
    if (first !== undefined) {
      const lines = bad.map(
        (s) =>
          `${s.status === "unsupported" ? "Not supported on Spark" : "Error"} (${s.kind}): ${oneLine(forSpark[s.index] ?? "", 100)}${s.message === null || s.message === undefined ? "" : ` -- ${s.message}`}`,
      );
      yield* logGap(name, script, { code: first.status, message: lines.join("; ") }, false);
      return yield* rejected(
        first.status === "unsupported" ? "0A000" : "42000",
        lines.join("\n"),
        "spark runs tables, views, indexes, enums and RLS policies; functions, triggers and extensions are not supported",
      );
    }
    yield* admin.applyMigration(version, name, script);
    yield* invalidate;
    // What Spark ran, so `db reset` replays it the same way.
    yield* writeMigrationFile(version, name, script).pipe(
      Effect.mapError((cause) =>
        rejected("58030", `cannot write the migration file: ${cause.message}`),
      ),
    );
    return version;
  });

  const routeSql = Effect.fn("SparkMeta.routeSql")(function* (
    query: string,
    parameters: ReadonlyArray<unknown>,
    readOnly: boolean,
    source: string,
  ) {
    const statements = splitSql(query);
    // GRANT and REVOKE run on Spark as migrations; Spark rejects REVOKE as not supported.
    const ignorable = (s: string) =>
      isGrantDo(s) || isSession(s) || (isDdl(s) && (words(s)[0] ?? "") === "comment");
    // Studio's grant loops, comments and session settings only: nothing Spark keeps.
    if (
      statements.length > 0 &&
      statements.every(ignorable) &&
      statements.some((s) => !isSession(s))
    )
      return { rows: [], target: "ignored" } satisfies Routed;
    if (statements.some(isDdl)) {
      if (readOnly)
        return yield* rejected("25006", "cannot execute DDL in a read-only transaction");
      yield* applySchemaChange(query, source);
      return { rows: [], target: "migration" } satisfies Routed;
    }
    const model = yield* current;
    const adapter = adapters.find((candidate) => candidate.match(query));
    if (adapter !== undefined) {
      const rows = yield* adapter.run({
        model,
        sql: query,
        params: parameters,
        spark: (q) => admin.query(q, [], true),
        migrations: admin.migrations,
        coerce: (r, sql) => coerceRows(model, r, sql),
        boolLiterals: (sql) => boolLiterals(model, sql),
      });
      return { rows, target: `adapter:${adapter.name}` } satisfies Routed;
    }
    const body = statements.filter(
      (s) =>
        !isSession(s) && !(/^do\s+\$/iu.test(s.trim()) && /pg_stat_statements\.track/u.test(s)),
    );
    if (body.length === 0) return { rows: [], target: "ignored" } satisfies Routed;
    const only = statements.length === 1 ? statements[0] : undefined;
    const rewritten = only === undefined ? undefined : rewriteEditorWrite(model, only);
    const sql = rewritten ?? body.join(";\n");
    if (/^\s*explain\b/iu.test(sql))
      return {
        rows: [{ "QUERY PLAN": "Result  (cost=0.00..0.01 rows=1 width=0)" }],
        target: "explain",
      } satisfies Routed;
    return yield* admin.query(sql, parameters, readOnly).pipe(
      Effect.map((rows): Routed => ({
        rows: coerceRows(model, rows, sql),
        target: rewritten === undefined ? "spark" : "spark:rewritten",
      })),
      Effect.catchTag("SparkQueryError", (error) =>
        Effect.gen(function* () {
          const catalog =
            /\b(pg_catalog|information_schema)\b|\bpg_[a-z_]+\b|::regclass|\bplpgsql\b/iu.test(
              stripComments(query),
            );
          yield* logGap(source, query, error, catalog);
          return yield* catalog
            ? new SparkQueryError({
                ...error,
                message: `${error.message}\nNot supported on Spark (catalog query not adapted): ${oneLine(query, 80)}`,
              })
            : error;
        }),
      ),
    );
  });

  /** pg-meta `/query` semantics over Spark: DDL, catalog adapters, editor writes, then Spark. */
  const runSql = Effect.fn("SparkMeta.runSql")(function* (
    query: string,
    parameters: ReadonlyArray<unknown>,
    readOnly: boolean,
    source: string,
  ) {
    yield* Effect.annotateCurrentSpan({ "spark.source": source });
    const routed = yield* routeSql(query, parameters, readOnly, source);
    yield* Effect.annotateCurrentSpan({
      "spark.target": routed.target,
      "spark.rows": routed.rows.length,
    });
    return routed;
  });

  const pgMetaRest = Effect.fn("SparkMeta.pgMetaRest")(function* (
    resourcePath: string,
    search: URLSearchParams,
  ) {
    const model = yield* current;
    const included = schemaList(search.get("included_schemas"));
    const excluded = schemaList(search.get("excluded_schemas")) ?? [];
    const inSchema = (schema: string) =>
      (included === undefined || included.includes(schema)) && !excluded.includes(schema);
    const match = /^\/([\w-]+)(?:\/(\d+))?\/?$/u.exec(resourcePath);
    const resource = match?.[1];
    const id = match?.[2];
    const pick = (rows: ReadonlyArray<{ readonly id: number | string }>) =>
      id === undefined ? rows : (rows.find((row) => String(row.id) === id) ?? null);
    const withColumns = search.get("include_columns") !== "false";
    const { description } = model;
    switch (resource) {
      case "tables":
        return json(
          pick(
            description.tables
              .filter((t) => inSchema(t.schema))
              .map((t) => model.table(t, withColumns)),
          ),
        );
      case "columns":
        return json(
          pick(
            description.tables
              .filter((t) => inSchema(t.schema))
              .flatMap((t) => t.columns.map((c) => model.column(t, c))),
          ),
        );
      case "views":
        return json(pick(description.views.filter((v) => inSchema(v.schema)).map(model.view)));
      case "schemas":
        return json(pick(model.schemas().filter((s) => inSchema(s.name))));
      case "policies":
        return json(pick(model.policies().filter((p) => inSchema(p.schema))));
      case "types":
        return json(pick(model.types().filter((t) => inSchema(t.schema))));
      case "roles":
        return json(pick(roleRows()));
      case "publications":
        return json(pick(publicationRows()));
      case "extensions":
      case "functions":
      case "triggers":
      case "materialized-views":
      case "foreign-tables":
      case "column-privileges":
      case "table-privileges":
        return json(id === undefined ? [] : null);
      case "config":
        return json([{ name: "server_version", setting: "17.0" }]);
      case "generators":
        if (resourcePath.startsWith("/generators/typescript"))
          return HttpServerResponse.text(yield* typescript(model, included ?? ["public"]), {
            headers: corsHeaders,
          });
    }
    return json(
      {
        message: `Not supported on Spark: GET /pg${resourcePath} is not served from the schema description`,
      },
      501,
    );
  });

  const project = () => ({
    id: settings.projectRef,
    ref: settings.projectRef,
    name: "spark-local",
    organization_id: "local",
    region: "local",
    status: "ACTIVE_HEALTHY",
    created_at: "1970-01-01T00:00:00.000Z",
    database: {
      host: "127.0.0.1",
      version: "17-spark",
      postgres_engine: "spark",
      release_channel: "ga",
    },
  });

  const typesFor = (search: URLSearchParams) =>
    current.pipe(
      Effect.flatMap((model) =>
        typescript(model, schemaList(search.get("included_schemas")) ?? ["public"]),
      ),
    );

  /** The Management API subset MCP and the CLI call; any access token is accepted locally. */
  const management = Effect.fn("SparkMeta.management")(function* (
    request: HttpServerRequest.HttpServerRequest,
    rest: string,
    search: URLSearchParams,
  ) {
    const method = request.method;
    if (rest === "" && method === "GET") return json(project());
    if (rest === "/database/query" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(QueryBody).pipe(
        Effect.mapError(() => rejected("22P02", "invalid request body")),
      );
      const routed = yield* runSql(
        body.query,
        body.parameters ?? [],
        body.read_only === true,
        "mcp",
      );
      return json(routed.rows, 201, { "x-spark-target": routed.target });
    }
    if (rest === "/database/migrations" && method === "GET")
      return json((yield* admin.migrations).map(({ version, name }) => ({ version, name })));
    if (rest === "/database/migrations" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(MigrationBody).pipe(
        Effect.mapError(() => rejected("22P02", "invalid request body")),
      );
      const name = body.name ?? "mcp";
      if (search.get("dry_run") === "true" || search.get("dry_run") === "1")
        return json({
          statuses: yield* dryRunSchemaChange(body.query, name, body.version ?? undefined),
        });
      const version = yield* applySchemaChange(body.query, name, body.version ?? undefined);
      return json({ version: version ?? null, name }, 201);
    }
    if (rest === "/database/dump" && method === "GET") {
      const model = yield* current;
      return HttpServerResponse.text(
        renderDump(model.description, schemaList(search.get("schemas"))),
        { headers: { ...corsHeaders, "content-type": "application/sql; charset=utf-8" } },
      );
    }
    if (rest.startsWith("/api-keys") && method === "GET")
      return json([
        { name: "anon", api_key: settings.anonKey, type: "legacy", id: "anon" },
        {
          name: "service_role",
          api_key: settings.serviceRoleKey,
          type: "legacy",
          id: "service_role",
        },
      ]);
    if (rest === "/types/typescript" && method === "GET")
      return json({ types: yield* typesFor(search) });
    if (rest.startsWith("/advisors/") && method === "GET") return json({ lints: [] });
    if (rest === "/health" && method === "GET")
      return json([{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }]);
    return json({ message: `not implemented on Spark: ${method} /v1/projects/{ref}${rest}` }, 501);
  });

  const route = Effect.fn("SparkMeta.request")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const url = new URL(request.url, "http://localhost");
    const p = url.pathname;
    const method = request.method;
    yield* Effect.annotateCurrentSpan({
      "http.method": method,
      "http.route": p.split("/").slice(0, 3).join("/"),
    });
    if (method === "OPTIONS")
      return HttpServerResponse.empty({
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
      });
    if (p === "/health") return json({ healthy: true });
    if (p === "/rest/v1/" && method === "GET") {
      const model = yield* current;
      return json(openApi(model.description, settings.publicUrl), 200, {
        "content-type": "application/openapi+json",
      });
    }
    if (p === "/pg/query" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(QueryBody).pipe(
        Effect.mapError(() => rejected("22P02", "invalid request body")),
      );
      const routed = yield* runSql(body.query, body.parameters ?? [], false, "studio");
      return json(routed.rows, 201, { "x-spark-target": routed.target });
    }
    if (p.startsWith("/pg/") && method === "GET")
      return yield* pgMetaRest(p.slice(3), url.searchParams);
    if (p.startsWith("/pg/"))
      return json({ message: `Not supported on Spark: ${method} ${p} (use POST /pg/query)` }, 501);
    if (p === "/_dev/types/typescript" && method === "GET")
      return HttpServerResponse.text(yield* typesFor(url.searchParams), { headers: corsHeaders });
    if (p === "/_dev/sync" && method === "POST") {
      yield* invalidate;
      const model = yield* current;
      return json({
        schemaVersion: model.description.schema_version,
        tables: model.description.tables.length,
      });
    }
    if (p === "/v1/projects" && method === "GET") return json([project()]);
    if (p === "/v1/organizations" && method === "GET")
      return json([{ id: "local", name: "Local" }]);
    const projectPath = /^\/v1\/projects\/([^/]+)(\/.*)?$/u.exec(p);
    if (projectPath !== null)
      return yield* management(request, projectPath[2] ?? "", url.searchParams);
    return json({ message: "not found" }, 404);
  });

  const fail = (error: SparkAdminError | AdapterShapeError | SparkTypegenError) =>
    Effect.succeed(errorResponse(error));
  return (request: HttpServerRequest.HttpServerRequest) =>
    route(request).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.catchTags({
        SparkQueryError: fail,
        SparkTransportError: fail,
        AdapterShapeError: fail,
        SparkTypegenError: fail,
      }),
    );
});
