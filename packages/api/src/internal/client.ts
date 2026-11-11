import { Clock, Data, Duration, Effect, Option, Context, Random, Schedule } from "effect";
import * as Cause from "effect/Cause";
import { NodeInspectSymbol } from "effect/Inspectable";
import * as Redacted from "effect/Redacted";
import type { SchemaError } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type {
  OperationDefinition,
  OperationInput,
  OperationOutput,
  OperationId,
} from "../generated/contracts.ts";
import { apiConfigLayer } from "../config/api-config.layer.ts";
import { ApiConfig } from "../config/api-config.service.ts";

export interface SupabaseApiConfig {
  readonly baseUrl?: string | undefined;
  readonly accessToken?: string | Redacted.Redacted<string> | undefined;
  readonly userAgent?: string | undefined;
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
}

interface ResolvedSupabaseApiConfig {
  readonly baseUrl: string;
  readonly accessToken: string | Redacted.Redacted<string>;
  readonly userAgent?: string | undefined;
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Per-request overrides of the construction-time base URL, bearer token, headers, and retry policy. */
export interface SupabaseApiRequestOptions {
  readonly baseUrl?: string | undefined;
  readonly accessToken?: string | Redacted.Redacted<string> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly retry?: SupabaseApiRetryOptions | undefined;
}

/**
 * Retry policy for Management API requests. Failed attempts back off exponentially with full
 * jitter and honour `Retry-After` on any retried response.
 */
export interface SupabaseApiRetryOptions {
  /** Retries after the first attempt; defaults to 5. */
  readonly maxRetries?: number | undefined;
  /** Timeout of each attempt in milliseconds; defaults to 60 seconds, `Infinity` disables it. */
  readonly requestTimeoutMs?: number | undefined;
}

/**
 * Request options for `executeRaw`. `extraBody` fields are forwarded unvalidated, for
 * read-modify-write of server state the spec does not fully describe.
 */
export interface SupabaseApiRawRequestOptions extends SupabaseApiRequestOptions {
  /** Extra JSON body fields; fields the operation's schema declares take precedence. */
  readonly extraBody?: Readonly<Record<string, unknown>> | undefined;
}

export interface SupabaseApiClientOptions {
  readonly retry?: SupabaseApiRetryOptions | undefined;
  readonly transformClient?:
    | ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>)
    | undefined;
}

export type SupabaseApiError =
  | HttpBody.HttpBodyError
  | HttpClientError.HttpClientError
  | SchemaError
  | SupabaseApiInputError;

export interface SupabaseApiClientShape {
  readonly execute: <Id extends OperationId>(
    definition: OperationDefinition<Id>,
    input: OperationInput<Id>,
    options?: SupabaseApiRequestOptions,
  ) => Effect.Effect<OperationOutput<Id>, SupabaseApiError>;
  /**
   * Executes an operation but returns the raw HTTP response, without decoding
   * the output schema or filtering on status. Use this when the response body
   * can't satisfy the strict generated schema (e.g. a replay fixture embeds a
   * placeholder value that violates a field's pattern). Request building is
   * identical to `execute`.
   */
  readonly executeRaw: <Id extends OperationId>(
    definition: OperationDefinition<Id>,
    input: OperationInput<Id>,
    options?: SupabaseApiRawRequestOptions,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, SupabaseApiError>;
}

export class SupabaseApiClient extends Context.Service<SupabaseApiClient, SupabaseApiClientShape>()(
  "@supabase/api/SupabaseApiClient",
) {}

export class SupabaseApiConfigError extends Data.TaggedError("SupabaseApiConfigError")<{
  readonly message: string;
}> {
  override readonly name = "SupabaseApiConfigError";

  static {
    /* Keep native Error inspect output instead of Effect's toJSON view. */
    Object.defineProperty(this.prototype, NodeInspectSymbol, { value: undefined });
  }

  constructor(message: string) {
    super({ message });
  }

  override toJSON(): unknown {
    return { _tag: this._tag, name: this.name };
  }
}

export type SupabaseApiInputErrorSource = "generated_client" | "user_input";

/**
 * The generated client's input schema rejected the request before it was sent.
 * Defaults to `generated_client` since a rejection is usually a caller assembly
 * bug; command boundaries can reclassify a confirmed user-derived request as
 * `user_input`. The original schema failure is preserved as `cause`.
 */
export class SupabaseApiInputError extends Data.TaggedError("SupabaseApiInputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  override readonly name = "SupabaseApiInputError";
  #source: SupabaseApiInputErrorSource = "generated_client";

  static {
    /* Keep native Error inspect output instead of Effect's toJSON view. */
    Object.defineProperty(this.prototype, NodeInspectSymbol, { value: undefined });
  }

  get source(): SupabaseApiInputErrorSource {
    return this.#source;
  }

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(
      options === undefined || !("cause" in options)
        ? { message }
        : { message, cause: options.cause },
    );
  }

  override toJSON(): unknown {
    return { _tag: this._tag, name: this.name };
  }

  static markAsUserInput<T extends SupabaseApiInputError>(error: T): T {
    error.#source = "user_input";
    return error;
  }
}

/** Mark a confirmed user-derived request while preserving error identity. */
export function markSupabaseApiInputErrorAsUserInput<T extends SupabaseApiInputError>(error: T): T {
  return SupabaseApiInputError.markAsUserInput(error);
}

function resolveSupabaseApiConfig(
  config: SupabaseApiConfig = {},
): Effect.Effect<ResolvedSupabaseApiConfig, SupabaseApiConfigError, ApiConfig> {
  return Effect.gen(function* () {
    const apiConfig = yield* ApiConfig;
    const accessToken = config.accessToken ?? Option.getOrUndefined(apiConfig.accessToken);

    if (accessToken === undefined) {
      return yield* new SupabaseApiConfigError(
        "Missing access token. Provide `accessToken` or set `SUPABASE_ACCESS_TOKEN`.",
      );
    }

    return {
      baseUrl: config.baseUrl ?? apiConfig.baseUrl,
      accessToken,
      userAgent: config.userAgent,
      headers: config.headers,
    };
  });
}

function interpolatePath(
  template: string,
  pathParams: ReadonlyArray<string>,
  input: object,
): string {
  let resolved = template;
  for (const param of pathParams) {
    const value = revealRedactedValue(Reflect.get(input, param));
    resolved = resolved.replaceAll(`{${param}}`, encodeURIComponent(String(value)));
  }
  return resolved;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function revealRedactedValue(value: unknown): unknown {
  if (Redacted.isRedacted(value)) {
    return Redacted.value(value);
  }
  if (Array.isArray(value)) {
    return value.map(revealRedactedValue);
  }
  if (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams ||
    value instanceof FormData ||
    value instanceof Date ||
    value instanceof Blob
  ) {
    return value;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, revealRedactedValue(entry)]),
    );
  }
  return value;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const RETRY_BASE_DELAY = Duration.millis(250);
const RETRY_MAX_DELAY = Duration.seconds(4);
/** Longest `Retry-After` honoured; a longer wait returns the response to the caller instead of retrying. */
const RETRY_AFTER_MAX_DELAY = Duration.seconds(10);

function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "PUT" || method === "DELETE" || method === "HEAD";
}

function isRetryableTransportError(error: unknown): error is HttpClientError.HttpClientError {
  return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";
}

/** A 429 means the server did not process the request, so every method may be resent. */
function isRetryableResponse(response: HttpClientResponse.HttpClientResponse): boolean {
  return (
    response.status === 429 ||
    (response.status >= 500 &&
      response.status <= 599 &&
      isIdempotentMethod(response.request.method))
  );
}

/** A retryable response travelling the error channel so the retry schedule can inspect it. */
class RetryableResponse extends Data.TaggedError("RetryableResponse")<{
  readonly response: HttpClientResponse.HttpClientResponse;
}> {}

type RetryableFailure = HttpClientError.HttpClientError | RetryableResponse;

/** Parses a `Retry-After` value, either delta-seconds or an HTTP-date, into a wait. */
function parseRetryAfter(
  value: string | undefined,
  nowMillis: number,
): Option.Option<Duration.Duration> {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return Option.none();
  }
  if (/^\d+$/.test(trimmed)) {
    return Option.some(Duration.seconds(Number(trimmed)));
  }
  // HTTP-dates start with a day name; this keeps `Date.parse` from reading bare numbers as years.
  const dateMillis = /^[A-Za-z]/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isNaN(dateMillis)
    ? Option.none()
    : Option.some(Duration.millis(Math.max(0, dateMillis - nowMillis)));
}

function retryAfterOf(
  failure: RetryableFailure,
  nowMillis: number,
): Option.Option<Duration.Duration> {
  if (failure._tag !== "RetryableResponse") {
    return Option.none();
  }
  return parseRetryAfter(failure.response.headers["retry-after"], nowMillis);
}

function exceedsRetryAfterCap(
  response: HttpClientResponse.HttpClientResponse,
  nowMillis: number,
): boolean {
  return Option.exists(
    parseRetryAfter(response.headers["retry-after"], nowMillis),
    Duration.isGreaterThan(RETRY_AFTER_MAX_DELAY),
  );
}

function makeRetrySchedule(maxRetries: number) {
  return Schedule.exponential(RETRY_BASE_DELAY).pipe(
    Schedule.setInputType<RetryableFailure>(),
    Schedule.modifyDelay(({ input, duration, now }) =>
      Option.match(retryAfterOf(input, now), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.map(Random.next, (random) =>
            Duration.times(Duration.min(duration, RETRY_MAX_DELAY), random),
          ),
      }),
    ),
    Schedule.upTo({ times: maxRetries }),
    Schedule.tap(({ attempt }) => Effect.annotateCurrentSpan("http.request.resend_count", attempt)),
  );
}

function applySupabaseRetryPolicy(
  client: HttpClient.HttpClient,
  options?: SupabaseApiRetryOptions,
): HttpClient.HttpClient {
  return HttpClient.transform(client, (requestEffect, request) =>
    Effect.flatMap(Effect.service(RequestOverrides), (overrides) => {
      const timeoutMs =
        overrides?.retry?.requestTimeoutMs ??
        options?.requestTimeoutMs ??
        DEFAULT_REQUEST_TIMEOUT_MS;
      const maxRetries = overrides?.retry?.maxRetries ?? options?.maxRetries ?? DEFAULT_MAX_RETRIES;
      const retriesTransportErrors = isIdempotentMethod(request.method);
      const attempt: Effect.Effect<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError | Cause.TimeoutError,
        never
      > = Number.isFinite(timeoutMs) ? Effect.timeout(requestEffect, timeoutMs) : requestEffect;

      return attempt.pipe(
        Effect.catchIf(Cause.isTimeoutError, (error) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: error,
                description: "request timed out",
              }),
            }),
          ),
        ),
        Effect.flatMap((response) =>
          Effect.flatMap(Clock.currentTimeMillis, (nowMillis) =>
            isRetryableResponse(response) && !exceedsRetryAfterCap(response, nowMillis)
              ? Effect.fail(new RetryableResponse({ response }))
              : Effect.succeed(response),
          ),
        ),
        Effect.retry({
          schedule: makeRetrySchedule(maxRetries),
          while: (failure) =>
            failure._tag === "RetryableResponse" ||
            (retriesTransportErrors && isRetryableTransportError(failure)),
        }),
        Effect.catchTag("RetryableResponse", (failure) => Effect.succeed(failure.response)),
      );
    }),
  );
}

/**
 * Carries one request's overrides to the innermost client layer, so the client
 * handed to `transformClient` stays fully configured and overridden requests
 * still pass through it, the retry policy, and the timeout.
 */
const RequestOverrides = Context.Reference<SupabaseApiRequestOptions | undefined>(
  "@supabase/api/RequestOverrides",
  { defaultValue: () => undefined },
);

function applyRequestDefaults(
  request: HttpClientRequest.HttpClientRequest,
  config: ResolvedSupabaseApiConfig,
  overrides: SupabaseApiRequestOptions | undefined,
): HttpClientRequest.HttpClientRequest {
  const accessToken = overrides?.accessToken ?? config.accessToken;
  let next = HttpClientRequest.prependUrl(request, overrides?.baseUrl ?? config.baseUrl);
  next = HttpClientRequest.setHeader(
    next,
    "Authorization",
    `Bearer ${String(revealRedactedValue(accessToken))}`,
  );
  next = HttpClientRequest.setHeader(
    next,
    "User-Agent",
    config.userAgent ?? "supabase-api/unknown",
  );
  for (const headers of [config.headers, overrides?.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value !== undefined) {
        next = HttpClientRequest.setHeader(next, name, value);
      }
    }
  }
  return next;
}

function prepareClient(
  client: HttpClient.HttpClient,
  config: ResolvedSupabaseApiConfig,
  options?: SupabaseApiClientOptions,
): Effect.Effect<HttpClient.HttpClient> {
  const prefixed = client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.map(Effect.service(RequestOverrides), (overrides) =>
        applyRequestDefaults(request, config, overrides),
      ),
    ),
    // Trace context stays local; no API consumer reads it.
    HttpClient.transformResponse(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
  );

  const retried = applySupabaseRetryPolicy(prefixed, options?.retry);
  return options?.transformClient ? options.transformClient(retried) : Effect.succeed(retried);
}

/**
 * Whether a query-parameter value is the object form OpenAPI serializes as
 * `style: deepObject`. Arrays are excluded — they are the repeated-key form
 * `normalizeUrlValue` already handles.
 */
function isDeepObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrlValue(value: unknown): string | ReadonlyArray<string> {
  const revealed = revealRedactedValue(value);

  if (Array.isArray(revealed)) {
    return revealed.map((entry) => String(entry));
  }
  if (typeof revealed === "object" && revealed !== null) {
    return JSON.stringify(revealed);
  }
  return String(revealed);
}

function normalizeHeaderValue(value: unknown): string {
  const revealed = revealRedactedValue(value);
  if (Array.isArray(revealed)) {
    return revealed.map((entry) => String(entry)).join(",");
  }
  if (typeof revealed === "object" && revealed !== null) {
    return JSON.stringify(revealed);
  }
  return String(revealed);
}

function asFormDataInput(value: unknown): HttpBody.FormDataInput {
  const revealed = revealRedactedValue(value);
  if (typeof revealed === "object" && revealed !== null) {
    return Object.fromEntries(
      Object.entries(revealed).map(([key, entry]) => [
        key,
        Array.isArray(entry) ? entry.map(asFormDataValue) : asFormDataValue(entry),
      ]),
    );
  }
  return { value: asFormDataValue(revealed) };
}

function asFormDataValue(value: unknown): HttpBody.FormDataCoercible {
  const revealed = revealRedactedValue(value);
  if (
    revealed == null ||
    typeof revealed === "string" ||
    typeof revealed === "number" ||
    typeof revealed === "boolean" ||
    revealed instanceof Blob
  ) {
    return revealed;
  }
  if (revealed instanceof Uint8Array) {
    return new Blob([Uint8Array.from(revealed).buffer]);
  }
  if (revealed instanceof ArrayBuffer) {
    return new Blob([revealed]);
  }
  if (revealed instanceof Date) {
    return revealed.toISOString();
  }
  if (isPlainObject(revealed)) {
    return JSON.stringify(revealed);
  }
  if (typeof revealed === "object") {
    return JSON.stringify(revealed);
  }
  if (typeof revealed === "symbol") {
    return revealed.description ?? "";
  }
  if (typeof revealed === "bigint") {
    return String(revealed);
  }
  if (typeof revealed === "function") {
    return revealed.name;
  }
  return "";
}

function asUrlParamsInput(value: unknown): URLSearchParams | Record<string, unknown> {
  const revealed = revealRedactedValue(value);
  if (revealed instanceof URLSearchParams) {
    return revealed;
  }
  if (typeof revealed === "object" && revealed !== null) {
    return Object.fromEntries(Object.entries(revealed).map(([key, entry]) => [key, entry]));
  }
  return { value: String(revealed) };
}

function asBinaryRequestBody(value: unknown): Effect.Effect<Uint8Array, HttpBody.HttpBodyError> {
  const revealed = revealRedactedValue(value);
  if (revealed instanceof Uint8Array) {
    return Effect.succeed(revealed);
  }
  if (revealed instanceof ArrayBuffer) {
    return Effect.succeed(new Uint8Array(revealed));
  }
  if (revealed instanceof Blob) {
    return Effect.tryPromise({
      try: () => revealed.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      catch: (cause) => new HttpBody.HttpBodyError({ reason: { _tag: "JsonError" }, cause }),
    });
  }
  return Effect.succeed(new TextEncoder().encode(String(revealed)));
}

// Serializes JSON bodies with keys sorted alphabetically (recursively) so the
// wire format matches recorded replay fixtures; the spec's field order would
// otherwise diverge from them for multi-field bodies.
function sortJsonKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeysDeep);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonKeysDeep(value[key]);
  }
  return sorted;
}

function encodeBody(
  request: HttpClientRequest.HttpClientRequest,
  definition: OperationDefinition,
  input: object,
  extraBody: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError> {
  if (extraBody !== undefined && definition.requestBody.kind !== "json") {
    return Effect.die(`${definition.id} has no JSON field body to extend with extraBody.`);
  }

  if (definition.requestBody.kind === "none") {
    return Effect.succeed(request);
  }

  if (definition.requestBody.kind === "json") {
    const payload: Record<string, unknown> = { ...extraBody };
    for (const field of definition.requestBody.fields) {
      const value = Reflect.get(input, field);
      if (value !== undefined) {
        payload[field] = revealRedactedValue(value);
      }
    }
    return HttpClientRequest.bodyJson(request, sortJsonKeysDeep(payload));
  }

  const body = revealRedactedValue(Reflect.get(input, definition.requestBody.field));

  if (definition.requestBody.contentType.endsWith("vnd.denoland.eszip")) {
    return asBinaryRequestBody(body).pipe(
      Effect.map((bytes) =>
        HttpClientRequest.bodyUint8Array(request, bytes, "application/vnd.denoland.eszip"),
      ),
    );
  }

  switch (definition.requestBody.contentType) {
    case "application/json":
      return HttpClientRequest.bodyJson(request, sortJsonKeysDeep(body));
    case "application/x-www-form-urlencoded":
      return Effect.succeed(HttpClientRequest.bodyUrlParams(request, asUrlParamsInput(body)));
    case "multipart/form-data":
      return Effect.succeed(
        body instanceof FormData
          ? HttpClientRequest.bodyFormData(request, body)
          : HttpClientRequest.bodyFormDataRecord(request, asFormDataInput(body)),
      );
  }

  return HttpClientRequest.bodyJson(request, body);
}

function buildRequest(
  definition: OperationDefinition,
  input: object,
  extraBody?: Readonly<Record<string, unknown>>,
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError> {
  const path = interpolatePath(definition.path, definition.pathParams, input);
  let request = HttpClientRequest.make(definition.method)(path);

  if (definition.response.kind === "json") {
    request = HttpClientRequest.acceptJson(request);
  }

  const query: Record<string, string | ReadonlyArray<string>> = {};
  for (const param of definition.queryParams) {
    const value = revealRedactedValue(Reflect.get(input, param));
    if (value === undefined) {
      continue;
    }
    // `style: deepObject` — every object-valued query parameter this spec
    // declares (the v2 `page` / `filter` pairs) — is one `param[key]=value` on
    // the wire, not a JSON blob: `page: { size: 100 }` must arrive as
    // `page[size]=100` or the server reads no page size at all.
    if (isDeepObjectValue(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
          query[`${param}[${key}]`] = normalizeUrlValue(entry);
        }
      }
      continue;
    }
    query[param] = normalizeUrlValue(value);
  }
  if (Object.keys(query).length > 0) {
    request = HttpClientRequest.setUrlParams(request, query);
  }

  for (const param of definition.headerParams) {
    const value = revealRedactedValue(Reflect.get(input, param));
    if (value !== undefined) {
      request = HttpClientRequest.setHeader(request, param, normalizeHeaderValue(value));
    }
  }

  return encodeBody(request, definition, input, extraBody);
}

function executeRequest(
  client: HttpClient.HttpClient,
  definition: OperationDefinition,
  input: object,
  options: SupabaseApiRequestOptions | undefined,
): Effect.Effect<HttpClientResponse.HttpClientResponse, SupabaseApiError> {
  return Effect.gen(function* () {
    const request = yield* buildRequest(definition, input);
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(RequestOverrides, options));
    return yield* HttpClientResponse.filterStatusOk(response);
  }).pipe(Effect.withSpan(definition.id, { attributes: { "api.operation": definition.id } }));
}

function isJsonOperation<Id extends OperationId>(
  definition: OperationDefinition<Id>,
): definition is Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "json" } }
> {
  return definition.response.kind === "json";
}

function isTextOperation<Id extends OperationId>(
  definition: OperationDefinition<Id>,
): definition is Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "text" } }
> {
  return definition.response.kind === "text";
}

function isVoidOperation<Id extends OperationId>(
  definition: OperationDefinition<Id>,
): definition is Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "void" } }
> {
  return definition.response.kind === "void";
}

function decodeJsonResponse<Id extends OperationId>(
  definition: OperationDefinition<Id>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<OperationOutput<Id>, SupabaseApiError> {
  return HttpClientResponse.schemaBodyJson(definition.outputSchema)(response);
}

function decodeTextResponse<Id extends OperationId>(
  _definition: OperationDefinition<Id>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<OperationOutput<Id>, SupabaseApiError> {
  return response.text;
}

function decodeVoidResponse<Id extends OperationId>(
  _definition: OperationDefinition<Id>,
  _response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<OperationOutput<Id>, SupabaseApiError> {
  return Effect.void;
}

export function makeSupabaseApiClient(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Effect.Effect<SupabaseApiClientShape, SupabaseApiConfigError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const resolvedConfig = yield* resolveSupabaseApiConfig(config).pipe(
      Effect.provide(apiConfigLayer),
      Effect.mapError(
        (error) =>
          new SupabaseApiConfigError(
            error instanceof Error ? error.message : "Failed to resolve Supabase API config.",
          ),
      ),
    );
    const httpClient = yield* HttpClient.HttpClient;
    const prepared = yield* prepareClient(httpClient, resolvedConfig, options);
    // Excess keys fail instead of being stripped so a caller typo or stale field
    // never silently drops out of the request.
    const decodeInput = (definition: OperationDefinition, input: unknown) =>
      Schema.decodeUnknownEffect(definition.inputSchema)(input, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((error) => new SupabaseApiInputError(error.message, { cause: error })),
      );

    return {
      execute: (definition, input, requestOptions) =>
        Effect.gen(function* () {
          const validated = yield* decodeInput(definition, input);
          const response = yield* executeRequest(prepared, definition, validated, requestOptions);
          if (isJsonOperation(definition)) {
            return yield* decodeJsonResponse(definition, response);
          }
          if (isTextOperation(definition)) {
            return yield* decodeTextResponse(definition, response);
          }
          if (isVoidOperation(definition)) {
            return yield* decodeVoidResponse(definition, response);
          }
          return yield* Effect.die(`Unsupported response kind: ${definition.response.kind}`);
        }),
      executeRaw: (definition, input, requestOptions) =>
        Effect.gen(function* () {
          const validated = yield* decodeInput(definition, input);
          const request = yield* buildRequest(definition, validated, requestOptions?.extraBody);
          return yield* prepared
            .execute(request)
            .pipe(Effect.provideService(RequestOverrides, requestOptions));
        }).pipe(Effect.withSpan(definition.id, { attributes: { "api.operation": definition.id } })),
    };
  });
}
