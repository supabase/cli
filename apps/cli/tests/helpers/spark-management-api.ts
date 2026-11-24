import { BunHttpServer } from "@effect/platform-bun";
import { makeSparkAdmin, sparkDryRun, sparkTypescriptTypes } from "@supabase/stack/spark";
import { Data, DateTime, Effect, Option, Random, Schema } from "effect";
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

const CreateProjectBody = Schema.Struct({
  name: Schema.String,
  organization_slug: Schema.String,
  postgres_engine: Schema.optionalKey(Schema.String),
  db_pass: Schema.optionalKey(Schema.String),
});

class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {}

/** An instance owner failed to create, delete or reset a Spark instance. */
export class SparkInstanceError extends Data.TaggedError("SparkInstanceError")<{
  readonly message: string;
}> {}

/** Where a project's Spark serves, and the keys it accepts. */
export interface SparkConnection {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly anonKey: string;
}

/** Owns one Spark process per project ref, as the Spark host does for the platform. */
export interface SparkInstances {
  readonly create: (ref: string) => Effect.Effect<SparkConnection, SparkInstanceError>;
  readonly delete: (ref: string) => Effect.Effect<void, SparkInstanceError>;
  /** Empties the instance's database; its URL and keys stay. */
  readonly reset: (ref: string) => Effect.Effect<SparkConnection, SparkInstanceError>;
}

type StandInOptions =
  /** One Spark answers for every ref; `/rest/v1` and `/auth/v1` pass through to it. */
  | { readonly sparkUrl: string; readonly serviceRoleKey: string; readonly anonKey: string }
  /** Projects are created and deleted through the API, each on its own instance. */
  | {
      readonly instances: SparkInstances;
      readonly organizations: ReadonlyArray<{
        readonly id: string;
        readonly slug: string;
        readonly name: string;
      }>;
    };

interface HostedProject {
  readonly ref: string;
  readonly name: string;
  readonly organization: { readonly id: string; readonly slug: string };
  readonly createdAt: string;
  connection: SparkConnection;
  /** The first `GET` after create answers `COMING_UP`, so the CLI's wait is exercised. */
  reportedHealthy: boolean;
}

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

const randomRef = Effect.gen(function* () {
  let ref = "";
  for (let i = 0; i < 20; i++)
    ref += String.fromCharCode(97 + (yield* Random.nextIntBetween(0, 26, { halfOpen: true })));
  return ref;
});

/**
 * The Management API routes the Spark end-to-end tests and the Supabase MCP server call, over
 * Spark's admin routes, on its own port. Any access token is accepted. With one `sparkUrl`, every
 * project ref is that Spark, and `/rest/v1` and `/auth/v1` pass through to it, so the project URL
 * the MCP server returns serves the project's Data API. With `instances`, `POST /v1/projects`
 * creates a project on its own instance, and `GET /v1/projects/{ref}` carries its `api_url`.
 */
export const serveSparkManagementApi = Effect.fn("SparkManagementApi.serve")(function* (
  options: StandInOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const hosted = new Map<string, HostedProject>();
  const single = "sparkUrl" in options ? options : undefined;
  const organizations =
    "instances" in options
      ? options.organizations
      : [{ id: "local", slug: "local", name: "Local" }];

  const singleProject = (ref: string) => ({
    id: ref,
    ref,
    name: "spark-local",
    organization_id: "local",
    region: "local",
    status: "ACTIVE_HEALTHY",
    created_at: "1970-01-01T00:00:00.000Z",
    database: { host: "127.0.0.1", version: "17-spark", postgres_engine: "spark" },
  });
  const hostedProject = (project: HostedProject, status = "ACTIVE_HEALTHY") => ({
    id: project.ref,
    ref: project.ref,
    name: project.name,
    organization_id: project.organization.id,
    organization_slug: project.organization.slug,
    region: "local",
    status,
    created_at: project.createdAt,
    database: { host: "127.0.0.1", version: "17-spark", postgres_engine: "spark" },
  });
  const connectionOf = (ref: string): Option.Option<SparkConnection> =>
    single === undefined
      ? Option.map(Option.fromNullishOr(hosted.get(ref)), (project) => project.connection)
      : Option.some({
          url: single.sparkUrl,
          serviceRoleKey: single.serviceRoleKey,
          anonKey: single.anonKey,
        });

  const createProject = Effect.fn("SparkManagementApi.createProject")(function* () {
    if (!("instances" in options))
      return json({ message: "the single-Spark stand-in creates no project" }, 501);
    const body = yield* HttpServerRequest.schemaBodyJson(CreateProjectBody).pipe(
      Effect.mapError(invalidBody),
    );
    if (body.postgres_engine !== "spark")
      return json({ message: "the Spark stand-in creates only Spark projects" }, 400);
    const organization = organizations.find((org) => org.slug === body.organization_slug);
    if (organization === undefined)
      return json({ message: `no organization ${body.organization_slug}` }, 404);
    const ref = yield* randomRef;
    const connection = yield* options.instances.create(ref);
    const project: HostedProject = {
      ref,
      name: body.name,
      organization,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      connection,
      reportedHealthy: false,
    };
    hosted.set(ref, project);
    return json(hostedProject(project, "COMING_UP"), 201);
  });

  const projectRoute = Effect.fn("SparkManagementApi.project")(function* (
    method: string,
    ref: string,
    rest: string,
    search: URLSearchParams,
  ) {
    const project = hosted.get(ref);
    if (single === undefined && project === undefined)
      return json({ message: `Project ${ref} not found` }, 404);
    if (rest === "" && method === "GET") {
      if (project === undefined) return json(singleProject(ref));
      const status = project.reportedHealthy ? "ACTIVE_HEALTHY" : "COMING_UP";
      project.reportedHealthy = true;
      return json({ ...hostedProject(project, status), api_url: project.connection.url });
    }
    if (rest === "" && method === "DELETE" && project !== undefined && "instances" in options) {
      yield* options.instances.delete(ref);
      hosted.delete(ref);
      return json(hostedProject(project, "REMOVED"));
    }
    if (
      rest === "/database/reset" &&
      method === "POST" &&
      project !== undefined &&
      "instances" in options
    ) {
      project.connection = yield* options.instances.reset(ref);
      return json({});
    }
    const connection = Option.getOrUndefined(connectionOf(ref));
    if (connection === undefined) return json({ message: `Project ${ref} not found` }, 404);
    const admin = makeSparkAdmin(client, connection.url, connection.serviceRoleKey);
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
        { name: "anon", api_key: connection.anonKey, type: "legacy", id: "anon" },
        {
          name: "service_role",
          api_key: connection.serviceRoleKey,
          type: "legacy",
          id: "service_role",
        },
      ]);
    return json({ message: `not in the Spark stand-in: ${method} /v1/projects/{ref}${rest}` }, 404);
  });

  const passthrough = Effect.fn("SparkManagementApi.passthrough")(function* (
    sparkUrl: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const method = request.method;
    if (!HttpMethod.isHttpMethod(method)) return json({ message: "method not allowed" }, 405);
    const hasBody = HttpMethod.hasBody(method);
    const upstream = yield* client.execute(
      HttpClientRequest.make(method)(`${sparkUrl}${request.url}`, {
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
    if (single !== undefined && /^\/(rest|auth)\/v1(\/|$)/u.test(url.pathname))
      return yield* passthrough(single.sparkUrl, request);
    if (url.pathname === "/v1/organizations" && request.method === "GET")
      return json(organizations);
    if (url.pathname === "/v1/projects" && request.method === "GET")
      return json([...hosted.values()].map((project) => hostedProject(project)));
    if (url.pathname === "/v1/projects" && request.method === "POST") return yield* createProject();
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
      SparkInstanceError: (error) => Effect.succeed(json({ message: error.message }, 500)),
    }),
  );

  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 });
  yield* server.serve(route);
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die("the Spark stand-in listener has no TCP address");
  return `http://127.0.0.1:${server.address.port}`;
});
