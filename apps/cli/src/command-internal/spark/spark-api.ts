import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
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

const MigrationHistory = Schema.Array(
  Schema.Struct({
    version: Schema.String,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const AppliedMigration = Schema.Struct({ version: Schema.NullOr(Schema.String) });

const DryRunStatus = Schema.Struct({
  index: Schema.Finite,
  kind: Schema.String,
  status: Schema.String,
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  line: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  statement: Schema.String,
});
export type SparkDryRunStatus = typeof DryRunStatus.Type;

const DryRun = Schema.Struct({ statuses: Schema.Array(DryRunStatus) });

/**
 * A raw call for the Spark routes the Management API contract does not describe yet (the dump
 * and `?dry_run=true`), with the same base URL and access token as the typed client.
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

const projectPath = (ref: string, rest: string) =>
  // oxlint-disable-next-line supabase/no-raw-management-api-url -- the dump and dry-run routes are not in the Management API OpenAPI spec, so no typed operation exists
  `/v1/projects/${encodeURIComponent(ref)}${rest}`;

/** `GET /v1/projects/{ref}`: the project, which must exist for `link`. */
export const getSparkProject = Effect.fn("SparkApi.getProject")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProject, { ref })
    .pipe(Effect.mapError(apiFailure("GET project")));
  return yield* decodeJson("project", Project, yield* okText("GET project", response));
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
