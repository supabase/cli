import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Description, Migration, type Row, SchemaVersion, ScratchResult } from "./Description.ts";

/** A Postgres-shaped error Spark returned, or one the meta adapter raises for unsupported SQL. */
export class SparkQueryError extends Data.TaggedError("SparkQueryError")<{
  readonly code?: string;
  readonly message: string;
  readonly details?: string;
  readonly hint?: string;
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
});

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

const queryError = (status: number, text: string, statusText: string): SparkQueryError => {
  const body = decodeErrorBody(text);
  if (body._tag === "None") return new SparkQueryError({ message: text || statusText, status });
  const { code, message, details, hint } = body.value;
  return new SparkQueryError({
    message: message ?? statusText,
    status,
    ...(code === null || code === undefined ? {} : { code }),
    ...(details === null || details === undefined ? {} : { details }),
    ...(hint === null || hint === undefined ? {} : { hint }),
  });
};

const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));

/** Spark's admin API (`/_spark/v1/*`) authorized with the service_role key. */
export const makeSparkAdmin = (client: HttpClient.HttpClient, url: string, serviceKey: string) => {
  const request = Effect.fn("SparkMeta.admin")(function* <A>(
    schema: Schema.Codec<A, unknown>,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    yield* Effect.annotateCurrentSpan({ "spark.path": path, "http.method": method });
    const base = HttpClientRequest.make(method)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ apikey: serviceKey, authorization: `Bearer ${serviceKey}` }),
    );
    const outgoing = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
    const response = yield* client
      .execute(outgoing)
      .pipe(
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
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      text === "" ? "null" : text,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SparkTransportError({ message: `Unexpected Spark response for ${path}`, cause }),
      ),
    );
  });
  return {
    query: (query: string, parameters: ReadonlyArray<unknown>, readOnly: boolean) =>
      request(Rows, "POST", "/_spark/v1/query", { query, parameters, read_only: readOnly }).pipe(
        Effect.map((rows): ReadonlyArray<Row> => rows),
      ),
    migrations: request(Schema.Array(Migration), "GET", "/_spark/v1/migrations"),
    applyMigration: (version: string, name: string, sql: string) =>
      request(Schema.Unknown, "POST", "/_spark/v1/migrations", { version, name, sql }),
    schemaVersion: request(SchemaVersion, "GET", "/_spark/v1/schema/version"),
    schema: request(Description, "GET", "/_spark/v1/schema"),
    scratch: (files: ReadonlyArray<{ readonly name: string; readonly sql: string }>) =>
      request(ScratchResult, "POST", "/_spark/v1/scratch", {
        base: "current",
        files,
        order: "as_given",
      }),
  };
};

export type SparkAdmin = ReturnType<typeof makeSparkAdmin>;
