import { operationDefinitions } from "@supabase/api/effect";
import { SparkDryRunStatus } from "@supabase/stack/spark";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import {
  sanitizeErrorBody,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { SparkApiError } from "./spark-project.ts";

const apiFailure = (what: string) => (cause: { readonly message: string }) =>
  new SparkApiError({ message: `${what} failed: ${cause.message}`, cause });

/** Reads a response body and fails on a non-2xx status with the server's message. */
const okText = Effect.fnUntraced(function* (
  what: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  const text = yield* response.text.pipe(Effect.mapError(apiFailure(what)));
  yield* Effect.annotateCurrentSpan({ "http.status_code": response.status });
  if (response.status >= 200 && response.status < 300) return text;
  const message = Schema.decodeOption(
    Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
  )(text).pipe(
    Option.map((body) => body.message),
    Option.getOrElse(() => text),
    // The body is the server's, or a proxy's: no control sequences on the terminal, and capped.
    sanitizeErrorBody,
  );
  return yield* new SparkApiError({
    message: `${what} failed (HTTP ${response.status}): ${message}`,
    status: response.status,
  });
});

const decodeJson = <S extends Schema.Top>(what: string, schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (cause) =>
        new SparkApiError({ message: `unexpected ${what} response: ${cause.message}`, cause }),
    ),
  );

const Project = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  organization_id: Schema.optionalKey(Schema.String),
  organization_slug: Schema.optionalKey(Schema.String),
});

const ProjectDetail = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  organization_slug: Schema.optionalKey(Schema.String),
  api_url: Schema.optionalKey(Schema.String),
});

const CreatedProject = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  organization_slug: Schema.optionalKey(Schema.String),
});

const Organizations = Schema.Array(
  Schema.Struct({
    slug: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
  }),
);

const ApiKeys = Schema.Array(
  Schema.Struct({ name: Schema.String, api_key: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);

const MigrationHistory = Schema.Array(
  Schema.Struct({
    version: Schema.String,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const AppliedMigration = Schema.Struct({ version: Schema.NullOr(Schema.String) });

const DryRun = Schema.Struct({ statuses: Schema.Array(SparkDryRunStatus) });

/**
 * A raw call for the Spark routes and shapes the Management API contract does not describe yet
 * (the dump, `?dry_run=true`, the reset, a project without `db_pass`), with the same base URL and
 * access token as the typed client.
 */
const rawRequest = Effect.fn("SparkApi.rawRequest")(function* (
  what: string,
  request: HttpClientRequest.HttpClientRequest,
) {
  const settings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const client = yield* HttpClient.HttpClient;
  const token = Option.isSome(settings.accessToken)
    ? settings.accessToken
    : yield* credentials.getAccessToken.pipe(Effect.mapError(apiFailure(what)));
  if (Option.isNone(token))
    return yield* new SparkApiError({
      message:
        "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.",
    });
  const response = yield* client
    .execute(
      request.pipe(
        HttpClientRequest.prependUrl(settings.apiUrl.replace(/\/+$/u, "")),
        HttpClientRequest.bearerToken(Redacted.value(token.value)),
        HttpClientRequest.setHeader("user-agent", settings.userAgent),
      ),
    )
    .pipe(Effect.mapError(apiFailure(what)));
  return yield* okText(what, response);
});

/** Provides the typed Management API client, whose access token resolves on first use. */
export const withPlatformApi = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const api = yield* (yield* CommandPlatformApiFactory).make;
    return yield* effect.pipe(Effect.provideService(CommandPlatformApi, api));
  });

const projectPath = (ref: string, rest: string) =>
  // oxlint-disable-next-line supabase/no-raw-management-api-url -- the dump, dry-run and reset routes are not in the Management API OpenAPI spec, so no typed operation exists
  `/v1/projects/${encodeURIComponent(ref)}${rest}`;

/** `GET /v1/projects/{ref}`: the project, which must exist for `link`. */
export const getSparkProject = Effect.fn("SparkApi.getProject")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProject, { ref })
    .pipe(Effect.mapError(apiFailure("GET project")));
  return yield* decodeJson("project", Project, yield* okText("GET project", response));
});

/** `GET /v1/projects/{ref}`: the project's status and API URL, `None` when it does not exist. */
export const findSparkProject = Effect.fn("SparkApi.findProject")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProject, { ref })
    .pipe(Effect.mapError(apiFailure("GET project")));
  if (response.status === 404) return Option.none<typeof ProjectDetail.Type>();
  const project = yield* decodeJson(
    "project",
    ProjectDetail,
    yield* okText("GET project", response),
  );
  yield* Effect.annotateCurrentSpan({ "spark.project.status": project.status ?? "" });
  return Option.some(project);
});

/**
 * `POST /v1/projects` with `postgres_engine: "spark"`: no `db_pass` or region, which the typed
 * client's input requires, so it is a raw call. Resolves to the new project's ref.
 */
export const createSparkProject = Effect.fn("SparkApi.createProject")(function* (project: {
  readonly name: string;
  readonly organizationSlug: string;
}) {
  const text = yield* rawRequest(
    "create project",
    // oxlint-disable-next-line supabase/no-raw-management-api-url -- the typed input requires db_pass, which a Spark project has none of
    HttpClientRequest.post("/v1/projects").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        name: project.name,
        organization_slug: project.organizationSlug,
        postgres_engine: "spark",
      }),
    ),
  );
  const created = yield* decodeJson("create project", CreatedProject, text);
  const ref = created.ref ?? created.id;
  if (ref === undefined)
    return yield* new SparkApiError({ message: "create project answered no project ref" });
  yield* Effect.annotateCurrentSpan({ "spark.project.created": true });
  return ref;
});

/** `DELETE /v1/projects/{ref}`; a project that no longer exists counts as deleted. */
export const deleteSparkProject = Effect.fn("SparkApi.deleteProject")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1DeleteAProject, { ref })
    .pipe(Effect.mapError(apiFailure("delete project")));
  if (response.status === 404) return false;
  yield* okText("delete project", response);
  return true;
});

/** `GET /v1/organizations`: the slugs of the organizations the token can see. */
export const listSparkOrganizations = Effect.fn("SparkApi.listOrganizations")(function* () {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1ListAllOrganizations, {})
    .pipe(Effect.mapError(apiFailure("list organizations")));
  const orgs = yield* decodeJson(
    "organizations",
    Organizations,
    yield* okText("list organizations", response),
  );
  return orgs.flatMap((org) => (org.slug === undefined ? [] : [org.slug]));
});

/** `GET .../api-keys`: the project's legacy anon and service_role keys. */
export const getSparkApiKeys = Effect.fn("SparkApi.getApiKeys")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProjectApiKeys, { ref })
    .pipe(Effect.mapError(apiFailure("get api keys")));
  const keys = yield* decodeJson("api keys", ApiKeys, yield* okText("get api keys", response));
  const key = (name: string) => keys.find((k) => k.name === name)?.api_key ?? undefined;
  const anonKey = key("anon");
  const serviceRoleKey = key("service_role");
  if (anonKey === undefined || serviceRoleKey === undefined)
    return yield* new SparkApiError({
      message: `the project ${ref} has no anon or service_role key`,
    });
  return { anonKey, serviceRoleKey };
});

/** `POST .../database/reset`: empties a Spark project's database and its migration history. */
export const resetSparkDatabase = Effect.fn("SparkApi.resetDatabase")(function* (ref: string) {
  yield* rawRequest(
    "reset database",
    HttpClientRequest.post(projectPath(ref, "/database/reset")).pipe(
      HttpClientRequest.bodyJsonUnsafe({}),
    ),
  );
});

/** `GET .../database/migrations`: the versions the project has applied. */
export const listSparkMigrations = Effect.fn("SparkApi.listMigrations")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1ListMigrationHistory, { ref })
    .pipe(Effect.mapError(apiFailure("list migrations")));
  const history = yield* decodeJson(
    "migration history",
    MigrationHistory,
    yield* okText("list migrations", response),
  );
  yield* Effect.annotateCurrentSpan({ "spark.migrations.remote": history.length });
  return history;
});

/**
 * `POST .../database/migrations`: applies one migration under the given version. Resolves to the
 * recorded version, or `null` when the body had nothing Spark runs and nothing was recorded.
 */
export const applySparkMigration = Effect.fn("SparkApi.applyMigration")(function* (
  ref: string,
  migration: { readonly query: string; readonly name: string; readonly version: string },
) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(
      operationDefinitions.v1ApplyAMigration,
      { ref, query: migration.query, name: migration.name },
      { extraBody: { version: migration.version } },
    )
    .pipe(Effect.mapError(apiFailure("apply migration")));
  const { version } = yield* decodeJson(
    "apply migration",
    AppliedMigration,
    yield* okText(`apply migration ${migration.version}_${migration.name}`, response),
  );
  return version;
});

/** `POST .../database/migrations?dry_run=true`: Spark's status for every statement, applying nothing. */
export const dryRunSparkMigration = Effect.fn("SparkApi.dryRunMigration")(function* (
  ref: string,
  migration: { readonly query: string; readonly name: string },
) {
  const text = yield* rawRequest(
    "dry-run migration",
    HttpClientRequest.post(projectPath(ref, "/database/migrations")).pipe(
      HttpClientRequest.setUrlParam("dry_run", "true"),
      HttpClientRequest.bodyJsonUnsafe(migration),
    ),
  );
  const { statuses } = yield* decodeJson("dry run", DryRun, text);
  yield* Effect.annotateCurrentSpan({
    "spark.dry_run.statements": statuses.length,
    "spark.dry_run.refused": statuses.filter(isRefused).length,
  });
  return statuses;
});

/** `POST .../database/query`: runs SQL on the project and resolves to the response body text. */
export const runSparkQuery = Effect.fn("SparkApi.runQuery")(function* (
  ref: string,
  query: string,
  readOnly: boolean,
) {
  yield* Effect.annotateCurrentSpan({ "spark.query.read_only": readOnly });
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(
      operationDefinitions.v1RunAQuery,
      { ref, query, ...(readOnly ? { read_only: true } : {}) },
      // A statement runs as long as it needs: a timeout here would leave a write's outcome unknown.
      { retry: { requestTimeoutMs: Number.POSITIVE_INFINITY } },
    )
    .pipe(Effect.mapError(apiFailure("run query")));
  const body = yield* okText("run query", response);
  // The route answers 201; any other success is not this API (a proxy's page, for one).
  if (response.status !== 201)
    return yield* new SparkApiError({
      message: `run query failed: ${unexpectedStatusMessage(response.status, sanitizeErrorBody(body))}`,
      status: response.status,
    });
  return body;
});

/** Whether Spark refuses a statement it was asked to run. */
export const isRefused = (status: SparkDryRunStatus) =>
  status.status === "unsupported" || status.status === "error";

/** `GET .../database/dump`: schema-only Postgres DDL of the project's own schemas. */
export const dumpSparkSchema = Effect.fn("SparkApi.dump")(function* (
  ref: string,
  schemas: ReadonlyArray<string>,
) {
  const request = HttpClientRequest.get(projectPath(ref, "/database/dump"));
  const dump = yield* rawRequest(
    "database dump",
    schemas.length === 0
      ? request
      : request.pipe(HttpClientRequest.setUrlParam("schemas", schemas.join(","))),
  );
  yield* Effect.annotateCurrentSpan({ "spark.dump.bytes": dump.length });
  return dump;
});

/** `GET .../types/typescript`: TypeScript types for the given schemas. */
export const sparkTypescriptTypes = Effect.fn("SparkApi.typescriptTypes")(function* (
  ref: string,
  schemas: ReadonlyArray<string>,
) {
  const api = yield* CommandPlatformApi;
  const { types } = yield* api.v1
    .generateTypescriptTypes({
      ref,
      included_schemas: schemas.length > 0 ? schemas.join(",") : "public",
    })
    .pipe(Effect.mapError(apiFailure("generate types")));
  return types;
});
