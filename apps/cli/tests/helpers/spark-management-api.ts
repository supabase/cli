import { createHash } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import { makeSparkAdmin, sparkDryRun, sparkTypescriptTypes } from "@supabase/stack/spark";
import { Clock, Data, DateTime, Effect, Option, Random, Schema, Stream } from "effect";
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

const BulkUpdateBody = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    name: Schema.String,
    version: Schema.Finite,
    verify_jwt: Schema.optionalKey(Schema.Boolean),
    entrypoint_path: Schema.optionalKey(Schema.String),
    import_map_path: Schema.optionalKey(Schema.String),
  }),
);

const DeployMetadata = Schema.fromJsonString(
  Schema.Struct({
    entrypoint_path: Schema.String,
    import_map_path: Schema.optionalKey(Schema.String),
    verify_jwt: Schema.optionalKey(Schema.Boolean),
    name: Schema.optionalKey(Schema.String),
  }),
);

const CreateSecretsBody = Schema.Array(
  Schema.Struct({ name: Schema.String, value: Schema.String }),
);
const DeleteSecretsBody = Schema.Array(Schema.String);

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

/** Failures a test injects into the multi-project stand-in; it reads them on every request. */
export interface ManagementApiFaults {
  /** How many of the next `GET /v1/projects/{ref}/api-keys` calls answer 400, a status the CLI does not retry. */
  apiKeysFailures: number;
  /** `GET /v1/projects/{ref}` answers `api_url: null`. */
  nullApiUrl: boolean;
  /** How many of the next `POST /v1/projects/{ref}/database/reset` calls answer 400, resetting nothing. */
  resetFailures: number;
  /** `POST /v1/projects/{ref}/database/reset` does not answer, resetting nothing, until the test clears the fault. */
  stallReset: boolean;
  /** `POST /v1/projects` does not answer, creating nothing, until the test clears the fault. */
  stallCreate: boolean;
}

/** What the multi-project stand-in received, for a test to assert on. */
export interface ManagementApiLog {
  /** Each `POST .../functions/deploy`: its `metadata` part and the names of its file parts. */
  readonly deploys: Array<{
    readonly ref: string;
    readonly slug: string;
    readonly metadata: typeof DeployMetadata.Type;
    readonly files: ReadonlyArray<string>;
  }>;
  /** Each `PUT .../functions`: the slugs it carried. */
  readonly bulkUpdates: Array<{ readonly ref: string; readonly slugs: ReadonlyArray<string> }>;
}

/** A deployed function as the platform describes it; the stand-in does not run it. */
interface HostedFunction {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "ACTIVE";
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly verify_jwt: boolean;
  readonly entrypoint_path: string;
  readonly import_map_path?: string;
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
      readonly faults?: ManagementApiFaults;
      readonly log?: ManagementApiLog;
    };

interface HostedProject {
  readonly ref: string;
  readonly name: string;
  readonly organization: { readonly id: string; readonly slug: string };
  readonly createdAt: string;
  connection: SparkConnection;
  /** The first `GET` after create answers `COMING_UP`, so the CLI's wait is exercised. */
  reportedHealthy: boolean;
  readonly functions: Map<string, HostedFunction>;
  /** Secret values by name. */
  readonly secrets: Map<string, string>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
 * creates a project on its own instance, `GET /v1/projects/{ref}` carries its `api_url`, and the
 * project's functions and secrets routes keep their state in memory (no function runs).
 */
export const serveSparkManagementApi = Effect.fn("SparkManagementApi.serve")(function* (
  options: StandInOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const hosted = new Map<string, HostedProject>();
  const single = "sparkUrl" in options ? options : undefined;
  const faults = "instances" in options ? options.faults : undefined;
  const log = "instances" in options ? options.log : undefined;
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
    if (faults?.stallCreate === true) {
      // Held until the test clears the fault, then dropped without creating anything, so the
      // listener's shutdown does not wait on a handler that never ends.
      while (faults.stallCreate) yield* Effect.sleep("100 millis");
      return json({ message: "the create was dropped (injected)" }, 500);
    }
    const ref = yield* randomRef;
    const connection = yield* options.instances.create(ref);
    const project: HostedProject = {
      ref,
      name: body.name,
      organization,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      connection,
      reportedHealthy: false,
      functions: new Map(),
      secrets: new Map(),
    };
    hosted.set(ref, project);
    return json(hostedProject(project, "COMING_UP"), 201);
  });

  const upsertFunction = Effect.fnUntraced(function* (
    project: HostedProject,
    fn: {
      readonly slug: string;
      readonly name?: string | undefined;
      readonly verify_jwt?: boolean | undefined;
      readonly entrypoint_path?: string | undefined;
      readonly import_map_path?: string | undefined;
    },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const current = project.functions.get(fn.slug);
    const importMap = fn.import_map_path ?? current?.import_map_path;
    const next: HostedFunction = {
      id: current?.id ?? `${project.ref}-${fn.slug}`,
      slug: fn.slug,
      name: fn.name ?? current?.name ?? fn.slug,
      status: "ACTIVE",
      version: (current?.version ?? 0) + 1,
      created_at: current?.created_at ?? now,
      updated_at: now,
      verify_jwt: fn.verify_jwt ?? current?.verify_jwt ?? true,
      entrypoint_path: fn.entrypoint_path ?? current?.entrypoint_path ?? "index.ts",
      ...(importMap === undefined ? {} : { import_map_path: importMap }),
    };
    project.functions.set(fn.slug, next);
    return next;
  });

  /** `.../functions[/{slug}]` and `.../functions/deploy?slug=`, kept in memory. */
  const functionsRoute = Effect.fn("SparkManagementApi.functions")(function* (
    project: HostedProject,
    method: string,
    rest: string,
    search: URLSearchParams,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (rest === "" && method === "GET") return json([...project.functions.values()]);
    if (rest === "/deploy" && method === "POST") {
      const slug = search.get("slug");
      if (slug === null) return json({ message: "slug is required" }, 400);
      let metadataText: string | undefined;
      const files: Array<string> = [];
      yield* Stream.runForEach(request.multipartStream, (part) =>
        Effect.gen(function* () {
          if (part._tag === "Field" && part.key === "metadata") metadataText = part.value;
          if (part._tag === "File") {
            files.push(part.name);
            yield* part.contentEffect;
          }
        }),
      ).pipe(Effect.mapError(invalidBody));
      if (metadataText === undefined) return json({ message: "no metadata part" }, 400);
      const metadata = yield* Schema.decodeEffect(DeployMetadata)(metadataText).pipe(
        Effect.mapError(invalidBody),
      );
      log?.deploys.push({ ref: project.ref, slug, metadata, files });
      return json(yield* upsertFunction(project, { slug, ...metadata }), 201);
    }
    if (rest === "" && method === "PUT") {
      const body = yield* HttpServerRequest.schemaBodyJson(BulkUpdateBody).pipe(
        Effect.mapError(invalidBody),
      );
      log?.bulkUpdates.push({ ref: project.ref, slugs: body.map((fn) => fn.slug) });
      return json({
        functions: yield* Effect.forEach(body, (fn) => upsertFunction(project, fn)),
      });
    }
    const slug = decodeURIComponent(rest.slice(1));
    const found = project.functions.get(slug);
    if (found === undefined) return json({ message: `Function ${slug} not found` }, 404);
    if (method === "GET") return json(found);
    if (method === "DELETE") {
      project.functions.delete(slug);
      return json({});
    }
    return json({ message: `not in the Spark stand-in: ${method} functions${rest}` }, 404);
  });

  /** `.../secrets`, kept in memory; a listed value is the SHA-256 of the secret, as the platform shows it. */
  const secretsRoute = Effect.fn("SparkManagementApi.secrets")(function* (
    project: HostedProject,
    method: string,
  ) {
    if (method === "GET")
      return json(
        [...project.secrets.entries()].map(([name, value]) => ({ name, value: sha256(value) })),
      );
    if (method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(CreateSecretsBody);
      for (const secret of body) project.secrets.set(secret.name, secret.value);
      return json({}, 201);
    }
    if (method === "DELETE") {
      const body = yield* HttpServerRequest.schemaBodyJson(DeleteSecretsBody);
      for (const name of body) project.secrets.delete(name);
      return json({});
    }
    return json({ message: `not in the Spark stand-in: ${method} secrets` }, 404);
  }, Effect.mapError(invalidBody));

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
      return json({
        ...hostedProject(project, status),
        api_url: faults?.nullApiUrl === true ? null : project.connection.url,
      });
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
      if (faults?.stallReset === true) {
        while (faults.stallReset) yield* Effect.sleep("100 millis");
        return json({ message: "the reset was dropped (injected)" }, 500);
      }
      if (faults !== undefined && faults.resetFailures > 0) {
        faults.resetFailures -= 1;
        return json({ message: "the reset was rejected (injected)" }, 400);
      }
      project.connection = yield* options.instances.reset(ref);
      return json({});
    }
    if (project !== undefined && rest.startsWith("/functions"))
      return yield* functionsRoute(project, method, rest.slice("/functions".length), search);
    if (project !== undefined && rest === "/secrets") return yield* secretsRoute(project, method);
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
    if (
      rest === "/api-keys" &&
      method === "GET" &&
      faults !== undefined &&
      faults.apiKeysFailures > 0
    ) {
      faults.apiKeysFailures -= 1;
      return json({ message: "the api-keys call failed (injected)" }, 400);
    }
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
