import { Effect, Option, Context } from "effect";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import type { SchemaError } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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

export interface SupabaseApiRetryOptions {
  readonly maxRetries?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
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
  | SchemaError;

export interface SupabaseApiClientShape {
  readonly execute: <Id extends OperationId>(
    definition: OperationDefinition<Id>,
    input: OperationInput<Id>,
  ) => Effect.Effect<OperationOutput<Id>, SupabaseApiError>;
  /**
   * Execute an operation but return the raw HTTP response without decoding the
   * output schema or filtering on status. Use this when the response body
   * cannot satisfy the strict generated schema (e.g. cli-e2e replay fixtures
   * embed a `__PROJECT_REF__` placeholder that violates `ref`'s 20-char
   * pattern), so the caller can parse the body leniently. Request building —
   * URL, auth, headers, body serialization — is identical to `execute`.
   */
  readonly executeRaw: <Id extends OperationId>(
    definition: OperationDefinition<Id>,
    input: OperationInput<Id>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, SupabaseApiError>;
}

export class SupabaseApiClient extends Context.Service<SupabaseApiClient, SupabaseApiClientShape>()(
  "@supabase/api/SupabaseApiClient",
) {}

export class SupabaseApiConfigError extends Error {
  readonly _tag = "SupabaseApiConfigError";

  constructor(message: string) {
    super(message);
    this.name = "SupabaseApiConfigError";
  }
}

function resolveSupabaseApiConfig(
  config: SupabaseApiConfig = {},
): Effect.Effect<ResolvedSupabaseApiConfig, SupabaseApiConfigError, ApiConfig> {
  return Effect.gen(function* () {
    const apiConfig = yield* ApiConfig;
    const accessToken = config.accessToken ?? Option.getOrUndefined(apiConfig.accessToken);

    if (accessToken === undefined) {
      return yield* Effect.fail(
        new SupabaseApiConfigError(
          "Missing access token. Provide `accessToken` or set `SUPABASE_ACCESS_TOKEN`.",
        ),
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

function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "PUT" || method === "DELETE" || method === "HEAD";
}

function isRetryableTransportError(error: unknown): error is HttpClientError.HttpClientError {
  return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";
}

function isRetryableResponse(response: HttpClientResponse.HttpClientResponse): boolean {
  return (
    response.status >= 500 && response.status <= 599 && isIdempotentMethod(response.request.method)
  );
}

function applySupabaseRetryPolicy(
  client: HttpClient.HttpClient,
  options?: SupabaseApiRetryOptions,
): HttpClient.HttpClient {
  const maxRetries = options?.maxRetries ?? 5;
  const timeoutMs = options?.requestTimeoutMs ?? 60_000;

  return HttpClient.transform(client, (requestEffect, request) => {
    const attempt = (
      retries: number,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
      requestEffect.pipe(
        Effect.timeout(timeoutMs),
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
        Effect.catchIf(isRetryableTransportError, (error) =>
          retries < maxRetries ? attempt(retries + 1) : Effect.fail(error),
        ),
        Effect.flatMap((response) =>
          isRetryableResponse(response) && retries < maxRetries
            ? attempt(retries + 1)
            : Effect.succeed(response),
        ),
      );

    return attempt(0);
  });
}

function prepareClient(
  client: HttpClient.HttpClient,
  config: ResolvedSupabaseApiConfig,
  options?: SupabaseApiClientOptions,
): Effect.Effect<HttpClient.HttpClient> {
  const prefixed = client.pipe(
    HttpClient.mapRequest((request) => {
      let next = HttpClientRequest.prependUrl(request, config.baseUrl);
      next = HttpClientRequest.setHeader(
        next,
        "Authorization",
        `Bearer ${String(revealRedactedValue(config.accessToken))}`,
      );
      next = HttpClientRequest.setHeader(
        next,
        "User-Agent",
        config.userAgent ?? "supabase-api/unknown",
      );
      if (config.headers !== undefined) {
        for (const [name, value] of Object.entries(config.headers)) {
          if (value !== undefined) {
            next = HttpClientRequest.setHeader(next, name, value);
          }
        }
      }
      return next;
    }),
  );

  const retried = applySupabaseRetryPolicy(prefixed, options?.retry);
  return options?.transformClient ? options.transformClient(retried) : Effect.succeed(retried);
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
      try: async () => new Uint8Array(await revealed.arrayBuffer()),
      catch: (cause) => new HttpBody.HttpBodyError({ reason: { _tag: "JsonError" }, cause }),
    });
  }
  return Effect.succeed(new TextEncoder().encode(String(revealed)));
}

// Serialize JSON bodies with alphabetically-sorted keys (recursively) to match
// Go's `encoding/json`, which emits oapi-codegen's alphabetically-declared
// struct fields and sorts map keys. Without this, multi-field request bodies
// serialize in OpenAPI-spec field order and diverge from the Go CLI on the
// wire (only single/already-sorted bodies happen to match).
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
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError> {
  if (definition.requestBody.kind === "none") {
    return Effect.succeed(request);
  }

  if (definition.requestBody.kind === "json") {
    const payload: Record<string, unknown> = {};
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
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError> {
  const path = interpolatePath(definition.path, definition.pathParams, input);
  let request = HttpClientRequest.make(definition.method)(path);

  if (definition.response.kind === "json") {
    request = HttpClientRequest.acceptJson(request);
  }

  const query: Record<string, string | ReadonlyArray<string>> = {};
  for (const param of definition.queryParams) {
    const value = revealRedactedValue(Reflect.get(input, param));
    if (value !== undefined) {
      query[param] = normalizeUrlValue(value);
    }
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

  return encodeBody(request, definition, input);
}

function executeRequest(
  client: HttpClient.HttpClient,
  definition: OperationDefinition,
  input: object,
): Effect.Effect<HttpClientResponse.HttpClientResponse, SupabaseApiError> {
  return Effect.gen(function* () {
    const request = yield* buildRequest(definition, input);
    const response = yield* client.execute(request);
    return yield* HttpClientResponse.filterStatusOk(response);
  });
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

    return {
      execute: (definition, input) =>
        Effect.gen(function* () {
          const validated = yield* Schema.decodeUnknownEffect(definition.inputSchema)(input);
          const response = yield* executeRequest(prepared, definition, validated);
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
      executeRaw: (definition, input) =>
        Effect.gen(function* () {
          const validated = yield* Schema.decodeUnknownEffect(definition.inputSchema)(input);
          const request = yield* buildRequest(definition, validated);
          return yield* prepared.execute(request);
        }),
    };
  });
}
