import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { makeSparkAdmin } from "./Admin.ts";
import type { Description } from "./Description.ts";
import { makeSparkMetaHandler } from "./Handler.ts";

const todos: Description = {
  schema_version: "v1",
  managed_schemas: ["auth"],
  schemas: [{ name: "public", comment: null }],
  enums: [],
  views: [],
  tables: [
    {
      schema: "public",
      name: "todos",
      managed: false,
      rls_enabled: true,
      rls_forced: false,
      comment: null,
      columns: [
        {
          name: "id",
          position: 1,
          type: "bigint",
          not_null: true,
          default: null,
          identity: "d",
          generated: null,
          comment: null,
        },
        {
          name: "done",
          position: 2,
          type: "boolean",
          not_null: true,
          default: "false",
          identity: null,
          generated: null,
          comment: null,
        },
        {
          name: "tags",
          position: 3,
          type: "text[]",
          not_null: false,
          default: null,
          identity: null,
          generated: null,
          comment: null,
        },
      ],
      constraints: [
        {
          name: "todos_pkey",
          type: "p",
          def: "PRIMARY KEY (id)",
          columns: ["id"],
          references: null,
        },
      ],
      indexes: [],
      policies: [
        {
          name: "own",
          cmd: "*",
          permissive: true,
          roles: ["authenticated"],
          using: "true",
          check: null,
        },
      ],
    },
  ],
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SparkCall {
  readonly path: string;
  readonly dryRun: boolean;
  readonly body: unknown;
}

const KINDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^(begin|commit)\b/iu, "TransactionStmt", "transaction"],
  [/^set\b/iu, "VariableSetStmt", "session"],
  [/^create\s+table\b/iu, "CreateStmt", "ddl"],
  [/^create\s+function\b/iu, "CreateFunctionStmt", "ddl"],
  [/^alter\b/iu, "AlterTableStmt", "ddl"],
  [/^do\b/iu, "DoStmt", "other"],
  [/^insert\b/iu, "InsertStmt", "dml"],
];

/** Stands in for Spark's `pg_query` split for the scripts these tests send (`;` only inside `$$` bodies). */
const parse = (sql: string) =>
  (sql.match(/(?:\$\$[\s\S]*?\$\$|[^;])+/gu) ?? [])
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "")
    .map((statement, index) => {
      const [, kind, category] = KINDS.find(([pattern]) => pattern.test(statement)) ?? [
        undefined,
        "SelectStmt",
        "query",
      ];
      return { index, kind, category, statement, line: 1 };
    });

/** A Spark admin API double: one description, recorded calls, and canned query rows. */
const fakeSpark = (
  options: { readonly unsupported?: boolean; readonly description?: Description } = {},
) => {
  const description = options.description ?? todos;
  const calls: Array<SparkCall> = [];
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  const statusesOf = (sql: unknown) =>
    parse(typeof sql === "string" ? sql : "").map(({ index, kind, statement }) => ({
      index,
      kind,
      statement,
      status:
        kind === "TransactionStmt"
          ? "ignored"
          : options.unsupported === true && kind === "CreateFunctionStmt"
            ? "unsupported"
            : "ok",
      ...(options.unsupported === true && kind === "CreateFunctionStmt"
        ? { message: "CREATE FUNCTION is not supported" }
        : {}),
    }));
  const sqlOf = (body: unknown): unknown => {
    const files: unknown = Reflect.get(Object(body), "files");
    return Array.isArray(files)
      ? Reflect.get(Object(files[0]), "sql")
      : Reflect.get(Object(body), "sql");
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const path = url.pathname;
      const dryRun = url.searchParams.has("dry_run");
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const body: unknown = raw === "" ? undefined : decodeJson(raw);
      calls.push({ path, dryRun, body });
      const respond = (response: Response) => HttpClientResponse.fromWeb(request, response);
      switch (path) {
        case "/_spark/v1/dump":
          return respond(
            new Response(`dump of ${url.searchParams.get("schemas") ?? "everything"}`, {
              headers: { "content-type": "text/plain" },
            }),
          );
        case "/_spark/v1/schema/version":
          return respond(reply({ schema_version: description.schema_version }));
        case "/_spark/v1/schema":
          return respond(reply(description));
        case "/system/v1/migrations":
          if (request.method === "GET")
            return respond(reply([{ version: "20260101000000", name: "todos", statements: null }]));
          return respond(
            dryRun
              ? reply({ dry_run: true, statuses: statusesOf(sqlOf(body)) })
              : reply({ ok: true }),
          );
        case "/_spark/v1/parse":
          return respond(reply({ statements: parse(String(Reflect.get(Object(body), "sql"))) }));
        case "/database/query": {
          const query = String(Reflect.get(Object(body), "query"));
          if (query.includes("pg_enum"))
            return respond(
              reply(
                {
                  code: "42P01",
                  message: "no such table: pg_enum",
                  details: "spark detail",
                  hint: "spark hint",
                },
                400,
              ),
            );
          if (/^do\b/iu.test(query))
            return respond(
              reply(
                {
                  code: "0A000",
                  message: "DO is not supported",
                  formattedError: "ERROR:  0A000: DO is not supported (as Spark wrote it)",
                },
                400,
              ),
            );
          return respond(reply([{ id: 1, done: true, tags: ["a", "b"] }]));
        }
        default:
          return respond(reply({ message: "not found" }, 404));
      }
    }),
  );
  return { client, calls };
};

const withHandler = (spark: ReturnType<typeof fakeSpark>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "spark-meta-" });
    const migrationsDir = path.join(root, "migrations");
    const handler = yield* makeSparkMetaHandler(
      makeSparkAdmin(spark.client, "http://spark.test", "service-key"),
      {
        projectRef: "default",
        publicUrl: "http://127.0.0.1:54321",
        anonKey: "anon-key",
        serviceRoleKey: "service-key",
        migrationsDir,
        gapsFile: path.join(root, "gaps.jsonl"),
      },
    );
    const send = (
      method: string,
      target: string,
      body?: unknown,
      headers: Readonly<Record<string, string>> = {},
    ) =>
      handler(
        HttpServerRequest.fromWeb(
          new Request(`http://localhost${target}`, {
            method,
            headers:
              body === undefined ? headers : { "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      ).pipe(
        Effect.flatMap((response) => {
          const web = HttpServerResponse.toWeb(response);
          return Effect.promise(() => web.text()).pipe(
            Effect.map((text) => ({
              status: web.status,
              contentType: web.headers.get("content-type"),
              target: web.headers.get("x-spark-target"),
              text,
              body: web.headers.get("content-type")?.startsWith("application/sql")
                ? text
                : decodeJson(text),
            })),
          );
        }),
      );
    return { send, migrationsDir, fs };
  });

it.live("returns Spark's refusal of a query as Spark gave it, with nothing added", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark());

    const catalog = yield* send("POST", "/pg/query", {
      query: "select enumlabel from pg_catalog.pg_enum",
    });
    const doBlock = yield* send("POST", "/pg/query", { query: "do $$ begin end $$" });

    expect(catalog.status).toBe(400);
    expect(catalog.body).toMatchObject({
      code: "42P01",
      message: "no such table: pg_enum",
      details: "spark detail",
      hint: "spark hint",
    });
    expect(doBlock.status).toBe(400);
    expect(doBlock.body).toMatchObject({
      code: "0A000",
      message: "DO is not supported",
      formattedError: "ERROR:  0A000: DO is not supported (as Spark wrote it)",
      hint: null,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("applies DDL as a dry-run-checked Spark migration and records it as a migration file", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send, migrationsDir, fs } = yield* withHandler(spark);

    const { status } = yield* send("POST", "/pg/query", {
      query:
        "begin; create table public.notes (id bigint primary key); alter table public.notes add column body text; commit;",
    });

    expect(status).toBe(201);
    const applied = spark.calls.find(
      (call) => call.path === "/system/v1/migrations" && call.body !== undefined,
    );
    expect(applied?.body).toMatchObject({
      name: "studio",
      sql: "begin;\ncreate table public.notes (id bigint primary key);\nalter table public.notes add column body text;\ncommit;",
    });
    const files = yield* fs.readDirectory(migrationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_studio\.sql$/u);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("forwards a query and its parameters to Spark unchanged", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send } = yield* withHandler(spark);

    const query =
      "set statement_timeout = 0; insert into public.todos (done) values ($1) returning *";
    const { status, body, target } = yield* send("POST", "/v1/projects/default/database/query", {
      query,
      parameters: [true],
    });

    expect(status).toBe(201);
    expect(target).toBe("spark");
    expect(body).toEqual([{ id: 1, done: true, tags: ["a", "b"] }]);
    expect(spark.calls.find((call) => call.path === "/database/query")?.body).toEqual({
      query,
      parameters: [true],
      read_only: false,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses DDL Spark cannot run with that statement's own message, before applying", () =>
  Effect.gen(function* () {
    const spark = fakeSpark({ unsupported: true });
    const { send, migrationsDir, fs } = yield* withHandler(spark);

    const { status, body } = yield* send("POST", "/pg/query", {
      query:
        "create table public.notes (id bigint primary key); create function public.f() returns int language plpgsql as $$ begin return 1; end $$",
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "0A000", message: "CREATE FUNCTION is not supported" });
    expect(String(Reflect.get(Object(body), "details"))).toBe(
      "Not supported on Spark (CreateFunctionStmt): create function public.f() returns int language plpgsql as $$ begin return 1; end $$ -- CREATE FUNCTION is not supported",
    );
    expect(yield* fs.exists(migrationsDir)).toBe(false);
    const posts = spark.calls.filter(
      (call) => call.path === "/system/v1/migrations" && call.body !== undefined,
    );
    expect(posts.map((call) => call.dryRun)).toEqual([true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports an unreachable Spark as a server error rather than a SQL error", () =>
  Effect.gen(function* () {
    const unreachable = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      ),
    );
    const { send } = yield* withHandler({ client: unreachable, calls: [] });

    const { status, body } = yield* send("POST", "/pg/query", { query: "select 1" });

    expect(status).toBe(500);
    expect(String(Reflect.get(Object(body), "message"))).toContain("Spark is unreachable");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("dry-runs a migration through Spark and applies nothing", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send, migrationsDir, fs } = yield* withHandler(spark);

    const { status, body } = yield* send(
      "POST",
      "/v1/projects/default/database/migrations?dry_run=true",
      { name: "notes", query: "begin; create table public.notes (id bigint primary key); commit;" },
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      statuses: [
        { index: 0, kind: "TransactionStmt", status: "ignored", statement: "begin" },
        {
          index: 1,
          kind: "CreateStmt",
          status: "ok",
          statement: "create table public.notes (id bigint primary key)",
        },
        { index: 2, kind: "TransactionStmt", status: "ignored", statement: "commit" },
      ],
    });
    const migrationCalls = spark.calls.filter((call) => call.path === "/system/v1/migrations");
    expect(migrationCalls.filter((call) => call.body !== undefined)).toMatchObject([
      { dryRun: true, body: { name: "notes" } },
    ]);
    expect(yield* fs.exists(migrationsDir)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports a statement Spark cannot run as unsupported in a dry run", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark({ unsupported: true }));

    const { status, body } = yield* send(
      "POST",
      "/v1/projects/default/database/migrations?dry_run=1",
      { query: "create function public.f() returns int language sql as $$ select 1 $$" },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      statuses: [
        { index: 0, status: "unsupported", statement: expect.stringContaining("create function") },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("serves Spark's own dump, restricted to the requested schemas", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send } = yield* withHandler(spark);

    const all = yield* send("GET", "/v1/projects/default/database/dump");
    const some = yield* send("GET", "/v1/projects/default/database/dump?schemas=app,public");

    expect(all.status).toBe(200);
    expect(all.contentType).toBe("application/sql; charset=utf-8");
    expect(all.text).toBe("dump of everything");
    expect(some.text).toBe("dump of app,public");
    expect(spark.calls.some((call) => call.path === "/_spark/v1/schema")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects a migration version that is not digits before it can reach a file name", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send, migrationsDir, fs } = yield* withHandler(spark);

    for (const version of ["abc", "../x"]) {
      const { status, body } = yield* send("POST", "/v1/projects/default/database/migrations", {
        query: "create table public.notes (id bigint primary key)",
        version,
      });
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "22023" });
    }
    expect(spark.calls.some((call) => call.path === "/system/v1/migrations" && call.body)).toBe(
      false,
    );
    expect(yield* fs.exists(migrationsDir)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "reads dry_run case-insensitively and refuses an unknown or repeated value instead of applying",
  () =>
    Effect.gen(function* () {
      const spark = fakeSpark();
      const { send, migrationsDir, fs } = yield* withHandler(spark);
      const migration = { query: "create table public.notes (id bigint primary key)" };

      const dry = yield* send(
        "POST",
        "/v1/projects/default/database/migrations?dry_run=True",
        migration,
      );
      const unknown = yield* send(
        "POST",
        "/v1/projects/default/database/migrations?dry_run=maybe",
        migration,
      );
      const repeated = yield* send(
        "POST",
        "/v1/projects/default/database/migrations?dry_run=false&dry_run=true",
        migration,
      );

      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ statuses: [{ status: "ok" }] });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({ code: "22023" });
      expect(repeated.status).toBe(400);
      expect(yield* fs.exists(migrationsDir)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "passes read_only from /pg/query to the DDL guard, formatted the way Spark formats its errors",
  () =>
    Effect.gen(function* () {
      const { send } = yield* withHandler(fakeSpark());

      const { status, body } = yield* send("POST", "/pg/query", {
        query: "create table public.notes (id bigint primary key)",
        read_only: true,
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({
        code: "25006",
        formattedError: "ERROR:  25006: cannot execute DDL in a read-only transaction",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("serves the API keys to a bearer token, for any linked ref, on that exact path", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark());
    const auth = { authorization: "Bearer local" };

    const ok = yield* send("GET", "/v1/projects/default/api-keys?reveal=false", undefined, auth);
    const slash = yield* send("GET", "/v1/projects/default/api-keys/", undefined, auth);
    const anonymous = yield* send("GET", "/v1/projects/default/api-keys");
    const linkedRef = yield* send(
      "GET",
      "/v1/projects/sparkpocprojectlocal/api-keys",
      undefined,
      auth,
    );
    const suffix = yield* send("GET", "/v1/projects/default/api-keys/other", undefined, auth);
    const legacy = yield* send("GET", "/v1/projects/default/api-keys/legacy", undefined, auth);
    const legacyAnonymous = yield* send("GET", "/v1/projects/default/api-keys/legacy");

    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject([{ name: "anon" }, { name: "service_role" }]);
    expect(slash.status).toBe(200);
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).not.toContain("service-key");
    expect(linkedRef.status).toBe(200);
    expect(suffix.status).toBe(501);
    expect(legacy.status).toBe(200);
    expect(legacy.body).toEqual({ enabled: true });
    expect(legacyAnonymous.status).toBe(401);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("answers Studio's project detail at the platform API's path with the Spark engine", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark());

    const project = yield* send("GET", "/platform/projects/default");
    const nested = yield* send("GET", "/platform/projects/default/settings");

    expect(project.status).toBe(200);
    expect(project.body).toMatchObject({
      ref: "default",
      status: "ACTIVE_HEALTHY",
      restUrl: "http://127.0.0.1:54321/rest/v1/",
      postgres_engine: "spark",
    });
    expect(nested.status).not.toBe(200);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
