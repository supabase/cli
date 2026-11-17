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
  readonly body: unknown;
}

/** A Spark admin API double: one description, recorded calls, and canned query rows. */
const fakeSpark = (options: { readonly unsupported?: boolean } = {}) => {
  const calls: Array<SparkCall> = [];
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const body: unknown = raw === "" ? undefined : decodeJson(raw);
      calls.push({ path, body });
      const respond = (response: Response) => HttpClientResponse.fromWeb(request, response);
      switch (path) {
        case "/_spark/v1/schema/version":
          return respond(reply({ schema_version: todos.schema_version }));
        case "/_spark/v1/schema":
          return respond(reply(todos));
        case "/_spark/v1/migrations":
          return respond(
            request.method === "GET"
              ? reply([{ version: "20260101000000", name: "todos", statements: null }])
              : reply({ ok: true }),
          );
        case "/_spark/v1/scratch":
          return respond(
            reply({
              statuses: options.unsupported
                ? [{ index: 0, kind: "CreateFunctionStmt", status: "unsupported", message: "no" }]
                : [{ index: 0, kind: "CreateStmt", status: "ok" }],
            }),
          );
        case "/_spark/v1/query":
          return respond(reply([{ id: 1, done: 1, tags: "{a,b}" }]));
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
    const send = (method: string, target: string, body?: unknown) =>
      handler(
        HttpServerRequest.fromWeb(
          new Request(`http://localhost${target}`, {
            method,
            ...(body === undefined
              ? {}
              : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
          }),
        ),
      ).pipe(
        Effect.flatMap((response) => {
          const web = HttpServerResponse.toWeb(response);
          return Effect.promise(() => web.text()).pipe(
            Effect.map((text) => ({ status: web.status, body: decodeJson(text) })),
          );
        }),
      );
    return { send, migrationsDir, fs };
  });

it.live("answers Studio's pg-meta table listing from Spark's schema description", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark());

    const { status, body } = yield* send("GET", "/pg/tables?included_schemas=public");

    expect(status).toBe(200);
    expect(body).toMatchObject([
      {
        schema: "public",
        name: "todos",
        rls_enabled: true,
        primary_keys: [{ name: "id" }],
        columns: [
          { name: "id", is_identity: true, identity_generation: "BY DEFAULT" },
          { name: "done", format: "bool", default_value: "false" },
          { name: "tags", data_type: "ARRAY", format: "_text" },
        ],
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("types Spark's 0/1 booleans and text arrays back from the queried table's columns", () =>
  Effect.gen(function* () {
    const { send } = yield* withHandler(fakeSpark());

    const { status, body } = yield* send("POST", "/v1/projects/default/database/query", {
      query: "select id, done, tags from public.todos",
    });

    expect(status).toBe(201);
    expect(body).toEqual([{ id: 1, done: true, tags: ["a", "b"] }]);
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
      (call) => call.path === "/_spark/v1/migrations" && call.body !== undefined,
    );
    expect(applied?.body).toMatchObject({
      name: "studio",
      sql: "create table public.notes (id bigint primary key, body text);",
    });
    const files = yield* fs.readDirectory(migrationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_studio\.sql$/u);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runs a standalone GRANT on Spark as a migration, now that Spark keeps grants", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send } = yield* withHandler(spark);

    const { status } = yield* send("POST", "/pg/query", {
      query: "grant select on public.todos to anon",
    });

    expect(status).toBe(201);
    const applied = spark.calls.find(
      (call) => call.path === "/_spark/v1/migrations" && call.body !== undefined,
    );
    expect(applied?.body).toMatchObject({ sql: "grant select on public.todos to anon;" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses a statement Spark cannot run before anything is applied", () =>
  Effect.gen(function* () {
    const spark = fakeSpark({ unsupported: true });
    const { send } = yield* withHandler(spark);

    const { status, body } = yield* send("POST", "/v1/projects/default/database/migrations", {
      name: "add_fn",
      query: "create function public.f() returns int language sql as $$ select 1 $$",
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "0A000" });
    expect(String(Reflect.get(Object(body), "message"))).toContain("Not supported on Spark");
    expect(
      spark.calls.some((call) => call.path === "/_spark/v1/migrations" && call.body !== undefined),
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rewrites the table editor's populate_recordset insert into literal values", () =>
  Effect.gen(function* () {
    const spark = fakeSpark();
    const { send } = yield* withHandler(spark);

    yield* send("POST", "/pg/query", {
      query: `insert into public.todos (done, tags) select done, tags from json_populate_recordset(null::public.todos, '[{"done":true,"tags":["x"]}]') returning *`,
    });

    const query = spark.calls.find((call) => call.path === "/_spark/v1/query")?.body;
    expect(query).toMatchObject({
      query: `insert into public.todos (done, tags) values (true, '{"x"}')returning *`,
    });
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

    const { status, body } = yield* send("GET", "/pg/tables");

    expect(status).toBe(500);
    expect(String(Reflect.get(Object(body), "message"))).toContain("Spark is unreachable");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
