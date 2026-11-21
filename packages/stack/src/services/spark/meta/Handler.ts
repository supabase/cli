import { Clock, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { type SparkAdmin, SparkQueryError, type SparkAdminError } from "./Admin.ts";
import { oneLine, sparkDryRun, sparkTypescriptTypes } from "../SparkClient.ts";
import type { Description, ParsedStatement } from "./Description.ts";
import type { SparkTypegenError } from "./Typegen.ts";

export interface SparkMetaSettings {
  readonly projectRef: string;
  readonly publicUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  /** Where schema changes made through Studio or MCP are written as migration files. */
  readonly migrationsDir: string;
  /** JSON lines of SQL Spark could not run, for finding Spark gaps. */
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

const parseDryRun = (values: ReadonlyArray<string>): boolean | undefined => {
  if (values.length === 0) return false;
  const [value] = values;
  if (values.length > 1 || value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
};

const bearerToken = (request: HttpServerRequest.HttpServerRequest): string | undefined =>
  /^Bearer\s+(\S+)$/iu.exec(request.headers["authorization"] ?? "")?.[1];

const corsHeaders = { "access-control-allow-origin": "*" };

const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...corsHeaders, ...headers } });

const rejected = (code: string, message: string, hint?: string) =>
  new SparkQueryError({ code, message, status: 400, ...(hint === undefined ? {} : { hint }) });

/** The text `psql` prints, for an error Spark did not format. */
const formatError = ({ code, message, details, hint }: SparkQueryError) =>
  `ERROR:  ${code ?? ""}: ${message}${details === undefined ? "" : `\nDETAIL:  ${details}`}${hint === undefined ? "" : `\nHINT:  ${hint}`}`;

const errorResponse = (error: SparkAdminError | SparkTypegenError) => {
  if (error._tag !== "SparkQueryError") return json({ message: error.message }, 500);
  const { code, message, details, hint } = error;
  const formattedError = error.formattedError ?? formatError(error);
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

const script = (statements: ReadonlyArray<ParsedStatement>): string =>
  statements.map((s) => s.statement).join(";\n");

const GapRecord = Schema.Struct({
  at: Schema.String,
  source: Schema.String,
  catalog: Schema.Boolean,
  error: Schema.String,
  query: Schema.String,
});
const encodeGapRecord = Schema.encodeEffect(Schema.fromJsonString(GapRecord));

/** Answers Studio's pg-meta SQL and the Management API subset MCP uses, over Spark. */
export const makeSparkMetaHandler = Effect.fn("SparkMeta.make")(function* (
  admin: SparkAdmin,
  settings: SparkMetaSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cached = yield* Ref.make<Description | undefined>(undefined);

  /** Spark's description at its current schema version; fetched in full only when it changed. */
  const current = Effect.gen(function* () {
    const { schema_version } = yield* admin.schemaVersion;
    const hit = yield* Ref.get(cached);
    if (hit?.schema_version === schema_version) return hit;
    const description = yield* admin.schema;
    yield* Ref.set(cached, description);
    return description;
  }).pipe(Effect.withSpan("SparkMeta.description"));

  const invalidate = Ref.set(cached, undefined);
  const cachedDescription = { schema: current };

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

  /** Runs a migration in a rolled-back transaction on the current database and reports each statement. */
  const dryRunSchemaChange = Effect.fn("SparkMeta.dryRunSchemaChange")(function* (
    sql: string,
    name: string,
    wanted?: string,
  ) {
    if (wanted !== undefined && !/^\d+$/u.test(wanted))
      return yield* rejected("22023", "migration version must contain digits only");
    const statements = yield* admin.parse(sql);
    yield* Effect.annotateCurrentSpan({ "spark.statements": statements.length });
    if (statements.length === 0) return [];
    const version = wanted ?? migrationTimestamp(yield* Clock.currentTimeMillis);
    return yield* sparkDryRun(
      admin,
      { version, name, sql: `${script(statements)};` },
      (index) => statements[index]?.statement,
    );
  });

  /** Applies a schema change as a Spark migration after a dry run on a scratch copy. */
  const applySchemaChange = Effect.fn("SparkMeta.applySchemaChange")(function* (
    statements: ReadonlyArray<ParsedStatement>,
    name: string,
    wanted?: string,
  ) {
    if (wanted !== undefined && !/^\d+$/u.test(wanted))
      return yield* rejected("22023", "migration version must contain digits only");
    yield* Effect.annotateCurrentSpan({ "spark.statements": statements.length });
    if (statements.length === 0) return undefined;
    const migration = `${script(statements)};`;
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
    const dry = yield* admin.scratch([{ name: `${version}_${name}.sql`, sql: migration }]);
    const bad = dry.statuses.filter((s) => s.status === "unsupported" || s.status === "error");
    const first = bad[0];
    if (first !== undefined) {
      const summary = bad
        .map(
          (s) =>
            `${s.status === "unsupported" ? "Not supported on Spark" : "Error"} (${s.kind}): ${oneLine(s.statement ?? statements[s.index]?.statement ?? "", 100)}${s.message === null || s.message === undefined ? "" : ` -- ${s.message}`}`,
        )
        .join("\n");
      yield* logGap(name, migration, { code: first.status, message: summary }, false);
      // The first refusal's own code and message: Studio's pg-meta fallbacks match on them.
      return yield* new SparkQueryError({
        code: first.code ?? (first.status === "unsupported" ? "0A000" : "42000"),
        message: first.message ?? summary,
        details: summary,
        hint: "spark runs tables, views, indexes, enums and RLS policies; functions, triggers and extensions are not supported",
        status: 400,
      });
    }
    yield* admin.applyMigration(version, name, migration);
    yield* invalidate;
    // What Spark ran, so `db reset` replays it the same way.
    yield* writeMigrationFile(version, name, migration).pipe(
      Effect.mapError((cause) =>
        rejected("58030", `cannot write the migration file: ${cause.message}`),
      ),
    );
    return version;
  });

  /** DDL becomes a migration; everything else goes to Spark as sent, and its errors come back unchanged. */
  const routeSql = Effect.fn("SparkMeta.routeSql")(function* (
    query: string,
    parameters: ReadonlyArray<unknown>,
    readOnly: boolean,
    source: string,
  ) {
    const statements = yield* admin.parse(query);
    if (statements.some((s) => s.category === "ddl")) {
      if (readOnly)
        return yield* rejected("25006", "cannot execute DDL in a read-only transaction");
      // A migration is recorded as text: a bound value would be lost, on Spark and in the file.
      if (parameters.length > 0)
        return yield* rejected("0A000", "a script with a schema change takes no parameters");
      yield* applySchemaChange(statements, source);
      return { rows: [], target: "migration" } satisfies Routed;
    }
    return yield* admin.query(query, parameters, readOnly).pipe(
      Effect.map((rows): Routed => ({ rows, target: "spark" })),
      Effect.tapError((error) =>
        error._tag === "SparkQueryError"
          ? logGap(
              source,
              query,
              error,
              /\b(pg_catalog|information_schema)\b|\bpg_[a-z_]+\b|::regclass/iu.test(query),
            )
          : Effect.void,
      ),
    );
  });

  /** pg-meta `/query` semantics over Spark. */
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
    sparkTypescriptTypes(cachedDescription, schemaList(search.get("included_schemas")));

  /** The Management API subset MCP and the CLI call; any access token is accepted locally. */
  const management = Effect.fn("SparkMeta.management")(function* (
    request: HttpServerRequest.HttpServerRequest,
    ref: string,
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
      const dryRun = parseDryRun(search.getAll("dry_run"));
      if (dryRun === undefined)
        return yield* rejected("22023", "dry_run must be given once, as true, false, 1 or 0");
      if (dryRun)
        return json({
          statuses: yield* dryRunSchemaChange(body.query, name, body.version ?? undefined),
        });
      const version = yield* applySchemaChange(
        yield* admin.parse(body.query),
        name,
        body.version ?? undefined,
      );
      return json({ version: version ?? null, name }, 201);
    }
    if (rest === "/database/dump" && method === "GET") {
      return HttpServerResponse.text(yield* admin.dump(schemaList(search.get("schemas"))), {
        headers: { ...corsHeaders, "content-type": "application/sql; charset=utf-8" },
      });
    }
    const keysRoute = rest.replace(/\/$/u, "");
    if ((keysRoute === "/api-keys" || keysRoute === "/api-keys/legacy") && method === "GET") {
      if (bearerToken(request) === undefined)
        return json({ message: "Access token not provided" }, 401);
      if (keysRoute === "/api-keys/legacy") return json({ enabled: true });
      return json([
        { name: "anon", api_key: settings.anonKey, type: "legacy", id: "anon" },
        {
          name: "service_role",
          api_key: settings.serviceRoleKey,
          type: "legacy",
          id: "service_role",
        },
      ]);
    }
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
    if (p === "/pg/query" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(QueryBody).pipe(
        Effect.mapError(() => rejected("22P02", "invalid request body")),
      );
      const routed = yield* runSql(
        body.query,
        body.parameters ?? [],
        body.read_only === true,
        "studio",
      );
      return json(routed.rows, 201, { "x-spark-target": routed.target });
    }
    if (p.startsWith("/pg/"))
      return json({ message: `Not supported on Spark: ${method} ${p} (use POST /pg/query)` }, 501);
    if (p === "/v1/projects" && method === "GET") return json([project()]);
    // Studio's own project detail route comes here (the stack routes it from Studio's listener), at
    // the platform API's path: Studio's self-hosted project plus the engine the platform reports.
    const studioProject = /^\/platform\/projects\/([^/]+)$/u.exec(p);
    if (studioProject !== null && method === "GET")
      return json({
        id: 1,
        ref: studioProject[1],
        name: "Supabase Studio (CLI)",
        organization_id: 1,
        cloud_provider: "localhost",
        status: "ACTIVE_HEALTHY",
        region: "local",
        inserted_at: "2021-08-02T06:40:40.646Z",
        connectionString: "",
        restUrl: `${settings.publicUrl}/rest/v1/`,
        postgres_engine: "spark",
      });
    if (p === "/v1/organizations" && method === "GET")
      return json([{ id: "local", name: "Local" }]);
    // The stand-in Management API: what the standalone MCP server calls, and the test double of
    // the CLI's linked-project path. The CLI's local target calls Spark's admin routes directly.
    const projectPath = /^\/v1\/projects\/([^/]+)(\/.*)?$/u.exec(p);
    if (projectPath !== null)
      return yield* management(
        request,
        projectPath[1] ?? "",
        projectPath[2] ?? "",
        url.searchParams,
      );
    return json({ message: "not found" }, 404);
  });

  const fail = (error: SparkAdminError | SparkTypegenError) => Effect.succeed(errorResponse(error));
  return (request: HttpServerRequest.HttpServerRequest) =>
    route(request).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.catchTags({
        SparkQueryError: fail,
        SparkTransportError: fail,
        SparkTypegenError: fail,
      }),
    );
});
