import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  Description,
  Migration,
  ParseResult,
  type Row,
  SchemaVersion,
  DryRunResult,
} from "./Description.ts";

/** A Postgres-shaped error Spark returned, or one sparkmeta raises before Spark sees the SQL. */
export class SparkQueryError extends Data.TaggedError("SparkQueryError")<{
  readonly code?: string;
  readonly message: string;
  readonly details?: string;
  readonly hint?: string;
  /** The error as `psql` prints it; Spark sends it, sparkmeta builds it for errors it raises itself. */
  readonly formattedError?: string;
  readonly status: number;
}> {}

/** Spark could not be reached or answered with a body the contract does not describe. */
class SparkTransportError extends Data.TaggedError("SparkTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SparkAdminError = SparkQueryError | SparkTransportError;

const ErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  formattedError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

const queryError = (status: number, text: string, statusText: string): SparkQueryError => {
  const body = decodeErrorBody(text);
  if (body._tag === "None") return new SparkQueryError({ message: text || statusText, status });
  const { code, message, details, hint, formattedError } = body.value;
  return new SparkQueryError({
    message: message ?? statusText,
    status,
    ...(code === null || code === undefined ? {} : { code }),
    ...(details === null || details === undefined ? {} : { details }),
    ...(hint === null || hint === undefined ? {} : { hint }),
    ...(formattedError === null || formattedError === undefined ? {} : { formattedError }),
  });
};

const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));

/** Spark's admin API authorized with the service_role key: spark-server's routes, and `/_spark/v1/*` for the rest. */
export const makeSparkAdmin = (client: HttpClient.HttpClient, url: string, serviceKey: string) => {
  const requestText = Effect.fn("SparkMeta.admin")(function* (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    yield* Effect.annotateCurrentSpan({ "spark.path": path, "http.method": method });
    const base = HttpClientRequest.make(method)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ apikey: serviceKey, authorization: `Bearer ${serviceKey}` }),
    );
    const outgoing = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
    const response = yield* client.execute(outgoing).pipe(
      // Fetch keeps the `apikey` header across a cross-origin redirect, so a 3xx is an error, never followed.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(
        (cause) =>
          new SparkTransportError({ message: `Spark is unreachable: ${cause.message}`, cause }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (cause) => new SparkTransportError({ message: "Spark response was cut off", cause }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "http.status_code": response.status });
    if (response.status < 200 || response.status >= 300)
      return yield* queryError(response.status, text, `HTTP ${response.status}`);
    return text;
  });
  const request = <A>(
    schema: Schema.Codec<A, unknown>,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) =>
    requestText(method, path, body).pipe(
      Effect.flatMap((text) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(text === "" ? "null" : text).pipe(
          Effect.mapError(
            (cause) =>
              new SparkTransportError({ message: `Unexpected Spark response for ${path}`, cause }),
          ),
        ),
      ),
    );
  return {
    query: (query: string, parameters: ReadonlyArray<unknown>, readOnly: boolean) =>
      request(Rows, "POST", "/database/query", { query, parameters, read_only: readOnly }).pipe(
        Effect.map((rows): ReadonlyArray<Row> => rows),
      ),
    /** The rows as Spark's JSON text, which keeps their column order and number formatting. */
    queryText: (query: string, readOnly: boolean) =>
      requestText("POST", "/database/query", { query, parameters: [], read_only: readOnly }),
    parse: (sql: string) =>
      request(ParseResult, "POST", "/_spark/v1/parse", { sql }).pipe(
        Effect.map(({ statements }) => statements),
      ),
    migrations: request(Schema.Array(Migration), "GET", "/system/v1/migrations"),
    applyMigration: (version: string, name: string, sql: string) =>
      request(Schema.Unknown, "POST", "/system/v1/migrations", { version, name, sql }),
    dryRunMigration: (version: string, name: string, sql: string) =>
      request(DryRunResult, "POST", "/system/v1/migrations?dry_run=1", { version, name, sql }),
    /** Postgres DDL of the project's own schemas, or only of `schemas` when given. */
    dump: (schemas: ReadonlyArray<string> | undefined) =>
      requestText(
        "GET",
        schemas === undefined
          ? "/_spark/v1/dump"
          : `/_spark/v1/dump?schemas=${encodeURIComponent(schemas.join(","))}`,
      ),
    schemaVersion: request(SchemaVersion, "GET", "/_spark/v1/schema/version"),
    schema: request(Description, "GET", "/_spark/v1/schema"),
  };
};

export type SparkAdmin = ReturnType<typeof makeSparkAdmin>;
