import { BunHttpServer } from "@effect/platform-bun";
import { makeSparkAdmin, sparkDryRun, sparkTypescriptTypes } from "@supabase/stack/spark";
import { Data, Effect, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { migrationVersion } from "../../src/commands/experimental/spark/spark-target.ts";

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

class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const schemaList = (value: string | null) =>
  value === null ? undefined : value.split(",").filter((schema) => schema !== "");

const invalidBody = () => new BadRequest({ message: "invalid request body" });

// Headers that describe one hop, or an encoding the forwarded response would no longer match.
const notForwarded = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

/**
 * The Management API routes the Spark end-to-end test's linked-project steps and the Supabase MCP
 * server call, over a local Spark's admin routes, on its own port. Any access token and project ref
 * are accepted. `/rest/v1` and `/auth/v1` pass through to Spark, so the project URL the MCP server
 * returns serves the project's Data API.
 */
export const serveSparkManagementApi = Effect.fn("SparkManagementApi.serve")(function* (options: {
  readonly sparkUrl: string;
  readonly serviceRoleKey: string;
  readonly anonKey: string;
}) {
  const admin = makeSparkAdmin(
    yield* HttpClient.HttpClient,
    options.sparkUrl,
    options.serviceRoleKey,
  );
  const project = (ref: string) => ({
    id: ref,
    ref,
    name: "spark-local",
    organization_id: "local",
    region: "local",
    status: "ACTIVE_HEALTHY",
    created_at: "1970-01-01T00:00:00.000Z",
    database: { host: "127.0.0.1", version: "17-spark", postgres_engine: "spark" },
  });

  const projectRoute = Effect.fn("SparkManagementApi.project")(function* (
    method: string,
    ref: string,
    rest: string,
    search: URLSearchParams,
  ) {
    if (rest === "" && method === "GET") return json(project(ref));
    if (rest === "/database/query" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(QueryBody).pipe(
        Effect.mapError(invalidBody),
      );
      const rows = yield* admin.queryText(
        body.query,
        body.parameters ?? [],
        body.read_only === true,
      );
      return HttpServerResponse.text(rows, { status: 201, contentType: "application/json" });
    }
    if (rest === "/database/migrations" && method === "GET")
      return json((yield* admin.migrations).map(({ version, name }) => ({ version, name })));
    if (rest === "/database/migrations" && method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(MigrationBody).pipe(
        Effect.mapError(invalidBody),
      );
      const name = body.name ?? "migration";
      const version = body.version ?? (yield* migrationVersion);
      if (search.get("dry_run") === "true")
        return json({ statuses: yield* sparkDryRun(admin, { version, name, sql: body.query }) });
      yield* admin.applyMigration(version, name, body.query);
      return json({ version, name }, 201);
    }
    if (rest === "/database/dump" && method === "GET")
      return HttpServerResponse.text(yield* admin.dump(schemaList(search.get("schemas"))), {
        contentType: "application/sql",
      });
    if (rest === "/types/typescript" && method === "GET")
      return json({
        types: yield* sparkTypescriptTypes(admin, schemaList(search.get("included_schemas"))),
      });
    if (rest === "/api-keys/legacy" && method === "GET") return json({ enabled: true });
    if (rest === "/api-keys" && method === "GET")
      return json([
        { name: "anon", api_key: options.anonKey, type: "legacy", id: "anon" },
        {
          name: "service_role",
          api_key: options.serviceRoleKey,
          type: "legacy",
          id: "service_role",
        },
      ]);
    return json({ message: `not in the Spark stand-in: ${method} /v1/projects/{ref}${rest}` }, 404);
  });

  const client = yield* HttpClient.HttpClient;
  const passthrough = Effect.fn("SparkManagementApi.passthrough")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const method = request.method;
    if (!HttpMethod.isHttpMethod(method)) return json({ message: "method not allowed" }, 405);
    const hasBody = HttpMethod.hasBody(method);
    const upstream = yield* client.execute(
      HttpClientRequest.make(method)(`${options.sparkUrl}${request.url}`, {
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !notForwarded.has(name)),
        ),
      }).pipe(
        hasBody
          ? HttpClientRequest.bodyUint8Array(new Uint8Array(yield* request.arrayBuffer))
          : (self) => self,
      ),
    );
    return HttpServerResponse.uint8Array(new Uint8Array(yield* upstream.arrayBuffer), {
      status: upstream.status,
      headers: Object.fromEntries(
        Object.entries(upstream.headers).filter(([name]) => !notForwarded.has(name)),
      ),
    });
  });

  const route = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    if (/^\/(rest|auth)\/v1(\/|$)/u.test(url.pathname)) return yield* passthrough(request);
    if (url.pathname === "/v1/organizations" && request.method === "GET")
      return json([{ id: "local", slug: "local", name: "Local" }]);
    const projectPath = /^\/v1\/projects\/([^/]+)(\/.*)?$/u.exec(url.pathname);
    if (projectPath === null) return json({ message: "not found" }, 404);
    return yield* projectRoute(
      request.method,
      decodeURIComponent(projectPath[1] ?? ""),
      projectPath[2] ?? "",
      url.searchParams,
    );
  }).pipe(
    // The platform's own error shape: the CLI and the MCP server read `message`.
    Effect.catchTags({
      BadRequest: (error) => Effect.succeed(json({ message: error.message }, 400)),
      SparkQueryError: (error) =>
        Effect.succeed(
          json(
            { message: `Failed to run sql query: ${error.formattedError ?? error.message}` },
            error.status,
          ),
        ),
      SparkTransportError: (error) => Effect.succeed(json({ message: error.message }, 502)),
      SparkTypegenError: (error) => Effect.succeed(json({ message: error.message }, 500)),
    }),
  );

  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 });
  yield* server.serve(route);
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die("the Spark stand-in listener has no TCP address");
  return `http://127.0.0.1:${server.address.port}`;
});
