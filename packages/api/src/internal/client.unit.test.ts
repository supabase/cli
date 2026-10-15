import { describe, expect, test } from "vitest";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Random,
  Redacted,
} from "effect";
import { TestClock } from "effect/testing";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as UrlParams from "effect/http/UrlParams";
import * as Schema from "effect/Schema";

import { operationDefinitions } from "../generated/contracts.ts";
import {
  makeSupabaseApiClient,
  markSupabaseApiInputErrorAsUserInput,
  type SupabaseApiClientOptions,
  type SupabaseApiClientShape,
  type SupabaseApiRetryOptions,
  SupabaseApiInputError,
} from "./client.ts";

const textDecoder = new TextDecoder();

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  );
}

function oauthTokenResponse(
  request: HttpClientRequest.HttpClientRequest,
): HttpClientResponse.HttpClientResponse {
  return jsonResponse(request, 201, {
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
  });
}

function functionResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return jsonResponse(request, status, {
    id: "function-id",
    slug: "demo",
    name: "Demo Function",
    status: "ACTIVE",
    version: 1,
    created_at: 1_710_000_000,
    updated_at: 1_710_000_001,
    verify_jwt: true,
    entrypoint_path: "functions/demo/index.ts",
    import_map_path: "functions/demo/deno.json",
    ezbr_sha256: "abc123",
  });
}

function deployFunctionResponse(
  request: HttpClientRequest.HttpClientRequest,
): HttpClientResponse.HttpClientResponse {
  return jsonResponse(request, 201, {
    id: "function-id",
    slug: "demo",
    name: "Demo Function",
    status: "ACTIVE",
    version: 1,
    created_at: 1_710_000_000,
    updated_at: 1_710_000_001,
    verify_jwt: true,
    entrypoint_path: "functions/demo/index.ts",
    import_map_path: "functions/demo/deno.json",
  });
}

function requestUrl(request: HttpClientRequest.HttpClientRequest): URL {
  return new URL(request.url);
}

function requestBodyBytes(request: HttpClientRequest.HttpClientRequest): Uint8Array {
  if (request.body._tag !== "Uint8Array") {
    throw new Error(`Expected Uint8Array body, got ${request.body._tag}`);
  }
  return request.body.body;
}

function requestBodyText(request: HttpClientRequest.HttpClientRequest): string {
  return textDecoder.decode(requestBodyBytes(request));
}

function requestFormData(request: HttpClientRequest.HttpClientRequest): FormData {
  if (request.body._tag !== "FormData") {
    throw new Error(`Expected FormData body, got ${request.body._tag}`);
  }
  return request.body.formData;
}

function formDataTextValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string") {
    throw new Error(`Expected string form-data value for ${key}`);
  }
  return value;
}

async function formDataFileTexts(formData: FormData, key: string): Promise<Array<string>> {
  const values = formData.getAll(key);
  return Promise.all(
    values.map(async (value) => {
      if (typeof value === "string") {
        return value;
      }
      return value.text();
    }),
  );
}

function requestUrlParam(
  request: HttpClientRequest.HttpClientRequest,
  key: string,
): string | ReadonlyArray<string> | undefined {
  const value = UrlParams.getFirst(request.urlParams, key);
  return Option.isSome(value) ? value.value : undefined;
}

function transportError(
  request: HttpClientRequest.HttpClientRequest,
  description: string,
): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description,
    }),
  });
}

const config = {
  baseUrl: "https://api.supabase.com",
  accessToken: "test-token",
  userAgent: "supabase-api/test",
} as const;

/** Runs `effect` on a virtual clock with every retry jitter draw fixed at `jitter`. */
function onVirtualClock<A, E>(
  effect: Effect.Effect<A, E, TestClock.TestClock>,
  jitter = 0.5,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => jitter,
      }),
      Effect.provide(TestClock.layer()),
    ),
  );
}

/**
 * Starts one client call against a stub transport on the virtual clock and records the clock
 * reading of every request the transport receives.
 */
function startVirtualCall<A, E>(
  call: (client: SupabaseApiClientShape) => Effect.Effect<A, E, never>,
  respond: (
    request: HttpClientRequest.HttpClientRequest,
    attempt: number,
  ) => HttpClientResponse.HttpClientResponse | HttpClientError.HttpClientError,
  options?: SupabaseApiClientOptions,
) {
  return Effect.gen(function* () {
    const requestTimes: Array<number> = [];
    const fiber = yield* makeSupabaseApiClient(config, options).pipe(
      Effect.flatMap(call),
      Effect.exit,
      Effect.provide(
        httpClientLayer((request) =>
          Effect.gen(function* () {
            requestTimes.push(yield* Clock.currentTimeMillis);
            const outcome = respond(request, requestTimes.length);
            return yield* HttpClientError.isHttpClientError(outcome)
              ? Effect.fail(outcome)
              : Effect.succeed(outcome);
          }),
        ),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    return { requestTimes, fiber };
  });
}

const listProjects = (client: SupabaseApiClientShape) =>
  client.execute<"v1ListAllProjects">(operationDefinitions.v1ListAllProjects, {});

describe("makeSupabaseApiClient", () => {
  test("defaults request-schema failures to generated-client provenance", async () => {
    let requests = 0;
    const client = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            requests += 1;
            return Effect.succeed(jsonResponse(request, 200, {}));
          }),
        ),
      ),
    );

    const executeError = await Effect.runPromise(
      client
        .execute(operationDefinitions.v1DeleteAFunction, {
          ref: "invalid-ref",
          function_slug: "hello-world",
        })
        .pipe(Effect.flip),
    );
    const executeRawError = await Effect.runPromise(
      client
        .executeRaw(operationDefinitions.v1DeleteAFunction, {
          ref: "invalid-ref",
          function_slug: "hello-world",
        })
        .pipe(Effect.flip),
    );

    for (const error of [executeError, executeRawError]) {
      expect(error).toBeInstanceOf(SupabaseApiInputError);
      if (!(error instanceof SupabaseApiInputError)) {
        throw new Error("expected SupabaseApiInputError");
      }
      expect(error.source).toBe("generated_client");
    }

    if (!(executeRawError instanceof SupabaseApiInputError)) {
      throw new Error("expected SupabaseApiInputError");
    }
    expect(markSupabaseApiInputErrorAsUserInput(executeRawError)).toBe(executeRawError);
    expect(executeRawError.source).toBe("user_input");
    expect(requests).toBe(0);
  });

  test("rejects unknown request keys at any depth before sending a request", async () => {
    let requests = 0;
    const client = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            requests += 1;
            return Effect.succeed(jsonResponse(request, 200, {}));
          }),
        ),
      ),
    );
    const ref = "abcdefghijklmnopqrst";
    const topLevelExcess = { ref, requestedConfig: { database: true }, junk: 1 };
    const nestedExcess = { ref, requestedConfig: { database: true, junk: 1 } };

    const errors = await Promise.all([
      Effect.runPromise(
        client
          .execute(operationDefinitions.v1UpdateSslEnforcementConfig, topLevelExcess)
          .pipe(Effect.flip),
      ),
      Effect.runPromise(
        client
          .executeRaw(operationDefinitions.v1UpdateSslEnforcementConfig, nestedExcess)
          .pipe(Effect.flip),
      ),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(SupabaseApiInputError);
    }
    expect(errors[0]?.message).toContain('["junk"]');
    expect(errors[1]?.message).toContain('["requestedConfig"]["junk"]');
    expect(requests).toBe(0);
  });

  test("per-request options override the base URL, token, and headers for that request only", async () => {
    const seen: Array<{
      url: string;
      authorization: string | undefined;
      userAgent: string | undefined;
      custom: string | undefined;
    }> = [];
    const client = await Effect.runPromise(
      makeSupabaseApiClient({ ...config, headers: { "X-Custom": "default" } }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seen.push({
              url: request.url,
              authorization: request.headers.authorization,
              userAgent: request.headers["user-agent"],
              custom: request.headers["x-custom"],
            });
            return Effect.succeed(jsonResponse(request, 200, []));
          }),
        ),
      ),
    );

    await Effect.runPromise(
      client.execute(
        operationDefinitions.v1ListAllProjects,
        {},
        {
          baseUrl: "https://api.example.test/prefix",
          accessToken: Redacted.make("override-token"),
          headers: { "X-Custom": "override" },
        },
      ),
    );
    await Effect.runPromise(
      client.executeRaw(
        operationDefinitions.v1ListAllProjects,
        {},
        { baseUrl: "https://raw.example.test", accessToken: "raw-token" },
      ),
    );
    await Effect.runPromise(client.execute(operationDefinitions.v1ListAllProjects, {}));

    expect(seen).toEqual([
      {
        url: "https://api.example.test/prefix/v1/projects",
        authorization: "Bearer override-token",
        userAgent: "supabase-api/test",
        custom: "override",
      },
      {
        url: "https://raw.example.test/v1/projects",
        authorization: "Bearer raw-token",
        userAgent: "supabase-api/test",
        custom: "default",
      },
      {
        url: "https://api.supabase.com/v1/projects",
        authorization: "Bearer test-token",
        userAgent: "supabase-api/test",
        custom: "default",
      },
    ]);
  });

  test("requests with per-request overrides still pass through transformClient", async () => {
    const transformed: Array<string> = [];
    const wire: Array<{ url: string; stamp: string | undefined }> = [];
    const client = await Effect.runPromise(
      makeSupabaseApiClient(config, {
        transformClient: (inner) =>
          Effect.succeed(
            HttpClient.mapRequest(inner, (request) => {
              transformed.push(request.url);
              return HttpClientRequest.setHeader(request, "X-Stamp", "stamped");
            }),
          ),
      }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            wire.push({ url: request.url, stamp: request.headers["x-stamp"] });
            return Effect.succeed(jsonResponse(request, 200, []));
          }),
        ),
      ),
    );

    await Effect.runPromise(
      client.execute(
        operationDefinitions.v1ListAllProjects,
        {},
        { baseUrl: "https://api.example.test" },
      ),
    );

    expect(transformed).toEqual(["https://api.example.test/v1/projects"]);
    expect(wire).toEqual([{ url: "https://api.example.test/v1/projects", stamp: "stamped" }]);
  });

  test("fails request-body construction before sending a request", async () => {
    class BrokenBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new Error("body read failed"));
      }
    }

    let requests = 0;
    const error = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.executeRaw(operationDefinitions.v1CreateAFunction, {
            ref: "abcdefghijklmnopqrst",
            slug: "demo",
            body: new BrokenBlob([]),
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            requests += 1;
            return Effect.succeed(functionResponse(request, 201));
          }),
        ),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
    expect(requests).toBe(0);
  });

  test("executeRaw forwards extraBody fields and lets validated fields win", async () => {
    const bodies: unknown[] = [];
    await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.executeRaw(
            operationDefinitions.v1UpdatePostgresConfig,
            { ref: "abcdefghijklmnopqrst", effective_cache_size: "4GB" },
            {
              extraBody: {
                effective_cache_size: "1GB",
                future_parameter: "on",
              },
            },
          ),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            bodies.push(JSON.parse(requestBodyText(request)));
            return Effect.succeed(jsonResponse(request, 200, {}));
          }),
        ),
      ),
    );

    expect(bodies).toEqual([{ effective_cache_size: "4GB", future_parameter: "on" }]);
  });

  test("executeRaw rejects extraBody on operations without a JSON field body", async () => {
    let requests = 0;
    const exit = await Effect.runPromiseExit(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.executeRaw(operationDefinitions.v1ListAllProjects, {}, { extraBody: { a: 1 } }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            requests += 1;
            return Effect.succeed(jsonResponse(request, 200, []));
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(requests).toBe(0);
  });

  test("retries transport errors for GET requests", async () => {
    const { requestTimes, result } = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(listProjects, (request, attempt) =>
          attempt < 3 ? transportError(request, "socket reset") : jsonResponse(request, 200, []),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        return { requestTimes: call.requestTimes, result: yield* Fiber.join(call.fiber) };
      }),
    );

    expect(requestTimes).toHaveLength(3);
    expect(result).toEqual(Exit.succeed([]));
  });

  test("reveals redacted auth tokens only at the transport boundary", async () => {
    let authorizationHeader: string | undefined;

    const result = await Effect.runPromise(
      makeSupabaseApiClient({
        ...config,
        accessToken: Redacted.make("redacted-token"),
      }).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, {
            db_pass: "hunter2",
            name: "project-name",
            organization_slug: "my-org",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            authorizationHeader = request.headers.authorization;
            return Effect.succeed(
              jsonResponse(request, 200, {
                id: "project-id",
                ref: "abcdefghijklmnopqrst",
                organization_id: "org-id",
                organization_slug: "my-org",
                name: "project-name",
                region: "us-east-1",
                created_at: "2026-03-13T12:00:00.000Z",
                status: "ACTIVE_HEALTHY",
              }),
            );
          }),
        ),
      ),
    );

    expect(authorizationHeader).toBe("Bearer redacted-token");
    expect(result.ref).toBe("abcdefghijklmnopqrst");
  });

  test("applies default headers alongside auth, user agent, and request headers", async () => {
    let seenHeaders:
      | {
          authorization: string | undefined;
          userAgent: string | undefined;
          command: string | undefined;
          commandRunId: string | undefined;
          idempotencyKey: string | undefined;
        }
      | undefined;

    await Effect.runPromise(
      makeSupabaseApiClient({
        ...config,
        headers: {
          "X-Supabase-Command": "branches list",
          "X-Supabase-Command-Run-ID": "run-123",
        },
      }).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1ApplyAMigration">(operationDefinitions.v1ApplyAMigration, {
            ref: "abcdefghijklmnopqrst",
            query: "select 1",
            name: "smoke_test",
            "Idempotency-Key": "migration-123",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenHeaders = {
              authorization: request.headers.authorization,
              userAgent: request.headers["user-agent"],
              command: request.headers["x-supabase-command"],
              commandRunId: request.headers["x-supabase-command-run-id"],
              idempotencyKey: request.headers["idempotency-key"],
            };
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
            );
          }),
        ),
      ),
    );

    expect(seenHeaders).toEqual({
      authorization: "Bearer test-token",
      userAgent: "supabase-api/test",
      command: "branches list",
      commandRunId: "run-123",
      idempotencyKey: "migration-123",
    });
  });

  test("decodes nullable JWT templates in API key responses", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetProjectApiKeys">(operationDefinitions.v1GetProjectApiKeys, {
            ref: "abcdefghijklmnopqrst",
            reveal: true,
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            const url = requestUrl(request);
            expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/api-keys");
            expect(requestUrlParam(request, "reveal")).toBe("true");
            return Effect.succeed(
              jsonResponse(request, 200, [
                {
                  name: "anon",
                  type: "legacy",
                  api_key: "anon-key",
                  secret_jwt_template: null,
                },
                {
                  name: "service_role",
                  type: "secret",
                  api_key: "service-role-key",
                  secret_jwt_template: { role: "service_role" },
                },
              ]),
            );
          }),
        ),
      ),
    );

    expect(result).toEqual([
      {
        name: "anon",
        type: "legacy",
        api_key: "anon-key",
        secret_jwt_template: null,
      },
      {
        name: "service_role",
        type: "secret",
        api_key: "service-role-key",
        secret_jwt_template: { role: "service_role" },
      },
    ]);
  });

  // Regression payloads: the spec's Z-anchored pattern used to reject these and
  // break `link` and `branches list` outright.
  test("decodes timestamps with a numeric UTC offset", async () => {
    const apiKeys = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetProjectApiKeys">(operationDefinitions.v1GetProjectApiKeys, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, [
                {
                  name: "anon",
                  type: "legacy",
                  api_key: "anon-key",
                  inserted_at: "2026-05-01T08:00:00+00:00",
                  updated_at: "2026-05-01T08:00:00.123456+02:00",
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(apiKeys[0]?.inserted_at).toBe("2026-05-01T08:00:00+00:00");
    expect(apiKeys[0]?.updated_at).toBe("2026-05-01T08:00:00.123456+02:00");

    const branches = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1ListAllBranches">(operationDefinitions.v1ListAllBranches, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, [
                {
                  id: "6f8f9d2c-1f43-4b8a-9d0e-3a2b1c4d5e6f",
                  name: "preview",
                  project_ref: "abcdefghijklmnopqrst",
                  parent_project_ref: "tsrqponmlkjihgfedcba",
                  is_default: false,
                  persistent: false,
                  status: "MIGRATIONS_PASSED",
                  with_data: false,
                  created_at: "2026-08-06T19:27:30.261795+00:00",
                  updated_at: "2026-08-06T19:27:30.261795+00:00",
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(branches[0]?.created_at).toBe("2026-08-06T19:27:30.261795+00:00");
  });

  test("accepts missing custom-hostname SSL validation records", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetHostnameConfig">(operationDefinitions.v1GetHostnameConfig, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, {
                status: "2_initiated",
                custom_hostname: "shop.acme.dev",
                data: {
                  success: true,
                  errors: [],
                  messages: [],
                  result: {
                    id: "hostname-id",
                    hostname: "shop.acme.dev",
                    ssl: {
                      status: "pending_validation",
                    },
                    ownership_verification: {
                      type: "txt",
                      name: "_cf-custom-hostname.shop.acme.dev",
                      value: "verification-token",
                    },
                    custom_origin_server: "abcdefghijklmnopqrst.supabase.co",
                    status: "pending",
                  },
                },
              }),
            ),
          ),
        ),
      ),
    );

    expect(result.data.result.ssl?.validation_records).toBeUndefined();
  });

  test("accepts missing custom-hostname ownership verification", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetHostnameConfig">(operationDefinitions.v1GetHostnameConfig, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, {
                status: "4_origin_setup_completed",
                custom_hostname: "shop.acme.dev",
                data: {
                  success: true,
                  errors: [],
                  messages: [],
                  result: {
                    id: "hostname-id",
                    hostname: "shop.acme.dev",
                    ssl: {
                      status: "active",
                    },
                    custom_origin_server: "abcdefghijklmnopqrst.supabase.co",
                    status: "active",
                  },
                },
              }),
            ),
          ),
        ),
      ),
    );

    expect(result.data.result.ownership_verification).toBeUndefined();
    expect(result.data.result.ssl?.validation_records).toBeUndefined();
  });

  test("accepts processing custom-hostname responses without top-level status or hostname", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetHostnameConfig">(operationDefinitions.v1GetHostnameConfig, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, {
                data: {
                  success: true,
                  errors: [],
                  messages: [],
                  result: {
                    id: "hostname-id",
                    hostname: "shop.acme.dev",
                    ssl: {
                      status: "initializing",
                    },
                    ownership_verification: {
                      type: "txt",
                      name: "_cf-custom-hostname.shop.acme.dev",
                      value: "verification-token",
                    },
                    custom_origin_server: "abcdefghijklmnopqrst.supabase.co",
                    status: "pending",
                  },
                },
              }),
            ),
          ),
        ),
      ),
    );

    expect(result.status).toBeUndefined();
    expect(result.custom_hostname).toBeUndefined();
    expect(result.data.result.ssl?.validation_records).toBeUndefined();
  });

  test("does not retry 5xx responses for POST requests", async () => {
    let attempts = 0;

    const exit = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, {
            db_pass: "hunter2",
            name: "project-name",
            organization_slug: "my-org",
          }),
        ),
        Effect.exit,
        Effect.provide(
          httpClientLayer((request) => {
            attempts += 1;
            return Effect.succeed(
              jsonResponse(request, 500, {
                error: "do not retry post",
              }),
            );
          }),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("does not retry transport errors for POST requests", async () => {
    let attempts = 0;

    const exit = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, {
            db_pass: "hunter2",
            name: "project-name",
            organization_slug: "my-org",
          }),
        ),
        Effect.exit,
        Effect.provide(
          httpClientLayer((request) => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(transportError(request, "connection reset"))
              : Effect.succeed(
                  jsonResponse(request, 409, {
                    message: "project already exists",
                  }),
                );
          }),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("does not retry transport errors for PATCH requests", async () => {
    let attempts = 0;

    const exit = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1PatchAMigration">(operationDefinitions.v1PatchAMigration, {
            ref: "abcdefghijklmnopqrst",
            version: "20240101000000",
            name: "renamed",
          }),
        ),
        Effect.exit,
        Effect.provide(
          httpClientLayer((request) => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(transportError(request, "connection reset"))
              : Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
                );
          }),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("stops after the configured number of transport retries", async () => {
    const { requestTimes, exit } = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(
          listProjects,
          (request) => transportError(request, "still broken"),
          { retry: { maxRetries: 2 } },
        );
        yield* TestClock.adjust(Duration.minutes(1));
        return { requestTimes: call.requestTimes, exit: yield* Fiber.join(call.fiber) };
      }),
    );

    expect(requestTimes).toHaveLength(3);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("decodes text responses through the unified execute path", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1DiffABranch">(operationDefinitions.v1DiffABranch, {
            // Must satisfy the oneOf union's project-ref/uuid pattern; a free-form
            // string like "branch-ref" doesn't match either branch.
            branch_id_or_ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("select * from test;", {
                  status: 200,
                  headers: {
                    "content-type": "text/plain",
                  },
                }),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result).toBe("select * from test;");
  });

  test("decodes void responses through the unified execute path", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1DisablePreviewBranching">(
            operationDefinitions.v1DisablePreviewBranching,
            {
              ref: "abcdefghijklmnopqrst",
            },
          ),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 204,
                }),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result).toBeUndefined();
  });

  test("serializes oauth token exchange bodies as x-www-form-urlencoded", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1ExchangeOauthToken">(operationDefinitions.v1ExchangeOauthToken, {
            body: {
              grant_type: "authorization_code",
              client_id: "11111111-1111-4111-8111-111111111111",
              client_secret: "client-secret",
              code: "auth-code",
              code_verifier: "code-verifier",
              redirect_uri: "https://example.com/callback",
              resource: "https://mcp.supabase.com",
            },
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(oauthTokenResponse(request));
          }),
        ),
      ),
    );

    expect(result.access_token).toBe("access-token");
    expect(seenRequest).toBeDefined();
    expect(seenRequest?.headers["content-type"]).toBe("application/x-www-form-urlencoded");

    const url = requestUrl(seenRequest!);
    expect(url.pathname).toBe("/v1/oauth/token");
    expect(Array.from(url.searchParams.keys())).toEqual([]);

    const body = new URLSearchParams(requestBodyText(seenRequest!));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("code-verifier");
    expect(body.get("redirect_uri")).toBe("https://example.com/callback");
    expect(body.get("resource")).toBe("https://mcp.supabase.com");
    expect(body.has("refresh_token")).toBe(false);
    expect(body.has("scope")).toBe(false);
  });

  test("serializes refresh-token exchange bodies without omitted oauth fields", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1ExchangeOauthToken">(operationDefinitions.v1ExchangeOauthToken, {
            body: {
              grant_type: "refresh_token",
              refresh_token: "refresh-token",
              scope: "read:projects",
            },
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(oauthTokenResponse(request));
          }),
        ),
      ),
    );

    expect(result.refresh_token).toBe("refresh-token");

    const body = new URLSearchParams(requestBodyText(seenRequest!));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("scope")).toBe("read:projects");
    expect(body.has("code")).toBe(false);
    expect(body.has("client_id")).toBe(false);
  });

  test("serializes create function requests as eszip bodies with metadata query params", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;
    const body = new TextEncoder().encode("console.log('deploy create');");

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1CreateAFunction">(operationDefinitions.v1CreateAFunction, {
            ref: "abcdefghijklmnopqrst",
            slug: "demo",
            name: "Demo Function",
            verify_jwt: true,
            entrypoint_path: "functions/demo/index.ts",
            import_map_path: "functions/demo/deno.json",
            ezbr_sha256: "abc123",
            body,
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(functionResponse(request, 201));
          }),
        ),
      ),
    );

    expect(result.slug).toBe("demo");
    expect(seenRequest).toBeDefined();
    expect(seenRequest?.headers["content-type"]).toBe("application/vnd.denoland.eszip");
    expect(requestBodyBytes(seenRequest!)).toEqual(body);

    const url = requestUrl(seenRequest!);
    expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions");
    expect(requestUrlParam(seenRequest!, "slug")).toBe("demo");
    expect(requestUrlParam(seenRequest!, "name")).toBe("Demo Function");
    expect(requestUrlParam(seenRequest!, "verify_jwt")).toBe("true");
    expect(requestUrlParam(seenRequest!, "entrypoint_path")).toBe("functions/demo/index.ts");
    expect(requestUrlParam(seenRequest!, "import_map_path")).toBe("functions/demo/deno.json");
    expect(requestUrlParam(seenRequest!, "ezbr_sha256")).toBe("abc123");
  });

  test("serializes update function requests as eszip bodies with metadata query params", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;
    const body = new TextEncoder().encode("console.log('deploy update');").buffer;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1UpdateAFunction">(operationDefinitions.v1UpdateAFunction, {
            ref: "abcdefghijklmnopqrst",
            function_slug: "demo",
            slug: "demo-renamed",
            verify_jwt: true,
            entrypoint_path: "functions/demo/index.ts",
            import_map_path: "functions/demo/deno.json",
            ezbr_sha256: "def456",
            body,
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(functionResponse(request, 200));
          }),
        ),
      ),
    );

    expect(result.slug).toBe("demo");
    expect(seenRequest).toBeDefined();
    expect(seenRequest?.headers["content-type"]).toBe("application/vnd.denoland.eszip");
    expect(requestBodyBytes(seenRequest!)).toEqual(new Uint8Array(body));

    const url = requestUrl(seenRequest!);
    expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions/demo");
    expect(requestUrlParam(seenRequest!, "slug")).toBe("demo-renamed");
    expect(requestUrlParam(seenRequest!, "verify_jwt")).toBe("true");
    expect(requestUrlParam(seenRequest!, "entrypoint_path")).toBe("functions/demo/index.ts");
    expect(requestUrlParam(seenRequest!, "import_map_path")).toBe("functions/demo/deno.json");
    expect(requestUrlParam(seenRequest!, "ezbr_sha256")).toBe("def456");
  });

  test("serializes deploy function requests as multipart bodies with json metadata", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const metadata = {
      entrypoint_path: "functions/demo/index.ts",
      import_map_path: "functions/demo/deno.json",
      static_patterns: ["functions/demo/static/**/*.js"],
      verify_jwt: true,
      name: "demo",
    } as const;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1DeployAFunction">(operationDefinitions.v1DeployAFunction, {
            ref: "abcdefghijklmnopqrst",
            slug: "demo",
            bundleOnly: true,
            body: {
              metadata,
              file: [new Uint8Array([1, 2, 3]), new Blob(["deno-config"])],
            },
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(deployFunctionResponse(request));
          }),
        ),
      ),
    );

    expect(result.slug).toBe("demo");
    expect(seenRequest).toBeDefined();

    const url = requestUrl(seenRequest!);
    expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions/deploy");
    expect(requestUrlParam(seenRequest!, "slug")).toBe("demo");
    expect(requestUrlParam(seenRequest!, "bundleOnly")).toBe("true");

    const formData = requestFormData(seenRequest!);
    expect(JSON.parse(formDataTextValue(formData, "metadata"))).toEqual(metadata);
    expect(await formDataFileTexts(formData, "file")).toEqual([
      "\u0001\u0002\u0003",
      "deno-config",
    ]);
  });

  test("rejects string raw binary bodies at schema decode time", () => {
    expect(() =>
      Schema.decodeUnknownSync(operationDefinitions.v1CreateAFunction.inputSchema)({
        ref: "abcdefghijklmnopqrst",
        slug: "demo",
        body: "not-binary",
      }),
    ).toThrow();
  });

  test("rejects string multipart file entries at schema decode time", () => {
    expect(() =>
      Schema.decodeUnknownSync(operationDefinitions.v1DeployAFunction.inputSchema)({
        ref: "abcdefghijklmnopqrst",
        slug: "demo",
        body: {
          metadata: {
            entrypoint_path: "functions/demo/index.ts",
          },
          file: ["index.ts"],
        },
      }),
    ).toThrow();
  });

  test("surfaces a 404 on a v2 operation as a distinguishable status error and wires the request identically to v1", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const client = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(
              jsonResponse(request, 404, { message: "Organization not found" }),
            );
          }),
        ),
      ),
    );

    const error = await Effect.runPromise(
      client
        .execute(operationDefinitions.v2ListOrganizationMembers, { slug: "my-org" })
        .pipe(Effect.flip),
    );

    expect(HttpClientError.isHttpClientError(error)).toBe(true);
    if (!HttpClientError.isHttpClientError(error)) {
      throw new Error("expected HttpClientError");
    }
    expect(error.reason._tag).toBe("StatusCodeError");
    if (error.reason._tag !== "StatusCodeError") {
      throw new Error("expected StatusCodeError");
    }
    expect(error.reason.response.status).toBe(404);

    expect(seenRequest).toBeDefined();
    expect(seenRequest?.url).toBe("https://api.supabase.com/v2/organizations/my-org/members");
    expect(seenRequest?.headers.authorization).toBe("Bearer test-token");
  });

  test("decodes a nested v2GetProjectConfig payload through the unified execute path", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v2GetProjectConfig">(operationDefinitions.v2GetProjectConfig, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, {
                data: {
                  type: "project_config",
                  id: "abcdefghijklmnopqrst",
                  attributes: {
                    database: {
                      major_version: 17,
                      ssl_enforced: true,
                      network_restrictions: {
                        entitlement: "disallowed",
                        status: "stored",
                        allowed_cidrs: [],
                      },
                      postgres_settings: {},
                    },
                    pooler: {
                      pool_mode: "transaction",
                      ignore_startup_parameters: "",
                      server_idle_timeout: 0,
                      server_lifetime: 0,
                      query_wait_timeout: 0,
                      reserve_pool_size: 0,
                      default_pool_size: 0,
                      max_client_conn: 0,
                    },
                    auth: {},
                    api: {
                      db_schema: "public",
                      db_extra_search_path: "",
                      max_rows: 1000,
                      db_pool_acquisition_timeout: 0,
                      db_pool: null,
                    },
                    realtime: {
                      private_only: false,
                      max_concurrent_users: 0,
                      max_events_per_second: 0,
                      max_bytes_per_second: 0,
                      max_channels_per_client: 0,
                      max_joins_per_second: 0,
                      max_presence_events_per_second: 0,
                      max_payload_size_in_kb: 0,
                      presence_enabled: true,
                      suspend: false,
                      connection_pool: 0,
                      postgres_changes_pool: null,
                    },
                    storage: {
                      file_size_limit: 0,
                      features: {
                        image_transformation: { enabled: true },
                        s3_protocol: { enabled: true },
                        purge_cache: { enabled: true },
                        iceberg_catalog: {
                          enabled: false,
                          max_namespaces: 0,
                          max_tables: 0,
                          max_catalogs: 0,
                        },
                        vector_buckets: { enabled: false, max_buckets: 0, max_indexes: 0 },
                      },
                      capabilities: {
                        list_v2: true,
                        iceberg_catalog: true,
                        object_versioning: true,
                      },
                      upstream_target: "main",
                      migration_version: "1",
                    },
                  },
                },
              }),
            ),
          ),
        ),
      ),
    );

    expect(result.data.attributes.database.network_restrictions.entitlement).toBe("disallowed");
    expect(result.data.attributes.database.major_version).toBe(17);
    expect(result.data.attributes.storage.upstream_target).toBe("main");
    expect(result.data.attributes.api.db_pool).toBeNull();
  });
  // `style: deepObject` — every object-valued query parameter in the spec — is
  // one `param[key]=value` pair per entry. Serialized as a JSON blob instead,
  // the server reads no page size and no cursor, so a paginated walk silently
  // returns the first default-sized page forever.
  test("expands deepObject query parameters into one pair per entry", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const client = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(
              jsonResponse(request, 200, {
                data: [],
                links: { first: null, last: null, prev: null, next: null },
              }),
            );
          }),
        ),
      ),
    );

    await Effect.runPromise(
      client.execute(operationDefinitions.v2ListNotebooks, {
        ref: "abcdefghijklmnopqrst",
        page: { size: 100, after: "cursor-1" },
        filter: { name: "sales" },
      }),
    );

    expect(seenRequest).toBeDefined();
    expect(requestUrlParam(seenRequest!, "page[size]")).toBe("100");
    expect(requestUrlParam(seenRequest!, "page[after]")).toBe("cursor-1");
    expect(requestUrlParam(seenRequest!, "filter[name]")).toBe("sales");
    // The un-expanded names never reach the wire.
    expect(requestUrlParam(seenRequest!, "page")).toBeUndefined();
    expect(requestUrlParam(seenRequest!, "filter")).toBeUndefined();
  });
});

describe("retry policy", () => {
  const createProject = (client: SupabaseApiClientShape) =>
    client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, {
      db_pass: "hunter2",
      name: "project-name",
      organization_slug: "my-org",
    });

  const createdProject = (request: HttpClientRequest.HttpClientRequest) =>
    jsonResponse(request, 201, {
      id: "project-id",
      ref: "abcdefghijklmnopqrst",
      organization_id: "org-id",
      organization_slug: "my-org",
      name: "project-name",
      region: "us-east-1",
      created_at: "2026-03-13T12:00:00.000Z",
      status: "ACTIVE_HEALTHY",
    });

  const gaps = (times: ReadonlyArray<number>) => times.slice(1).map((time, i) => time - times[i]!);

  test.each([500, 503])(
    "waits out the backoff before retrying a GET after a %i",
    async (status) => {
      const { early, afterBackoff, exit } = await onVirtualClock(
        Effect.gen(function* () {
          const call = yield* startVirtualCall(listProjects, (request, attempt) =>
            attempt === 1 ? jsonResponse(request, status, {}) : jsonResponse(request, 200, []),
          );
          // The first backoff ceiling is 250ms, so a jitter draw of 0.5 waits 125ms.
          yield* TestClock.adjust(Duration.millis(124));
          const early = call.requestTimes.length;
          yield* TestClock.adjust(Duration.millis(1));
          const afterBackoff = call.requestTimes.length;
          return { early, afterBackoff, exit: yield* Fiber.join(call.fiber) };
        }),
      );

      expect(early).toBe(1);
      expect(afterBackoff).toBe(2);
      expect(exit).toEqual(Exit.succeed([]));
    },
  );

  test("backs off exponentially up to the delay cap", async () => {
    const requestTimes = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(
          listProjects,
          (request) => jsonResponse(request, 503, {}),
          { retry: { maxRetries: 8 } },
        );
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Fiber.join(call.fiber);
        return call.requestTimes;
      }),
      1,
    );

    expect(gaps(requestTimes)).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000, 4000]);
  });

  test("retries a POST after a 429 only once its Retry-After seconds have elapsed", async () => {
    const { early, afterWait, exit } = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(createProject, (request, attempt) =>
          attempt === 1
            ? HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
              )
            : createdProject(request),
        );
        yield* TestClock.adjust(Duration.millis(1999));
        const early = call.requestTimes.length;
        yield* TestClock.adjust(Duration.millis(1));
        const afterWait = call.requestTimes.length;
        return { early, afterWait, exit: yield* Fiber.join(call.fiber) };
      }),
    );

    expect(early).toBe(1);
    expect(afterWait).toBe(2);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("retries a GET immediately after a 500 with Retry-After 0", async () => {
    const requestTimes = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(listProjects, (request, attempt) =>
          attempt === 1
            ? HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: 500, headers: { "retry-after": "0" } }),
              )
            : jsonResponse(request, 200, []),
        );
        yield* TestClock.adjust(Duration.millis(0));
        yield* Fiber.join(call.fiber);
        return call.requestTimes;
      }),
    );

    expect(gaps(requestTimes)).toEqual([0]);
  });

  test("honours an HTTP-date Retry-After on a 503", async () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const requestTimes = await onVirtualClock(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const call = yield* startVirtualCall(listProjects, (request, attempt) =>
          attempt === 1
            ? HttpClientResponse.fromWeb(
                request,
                new Response("{}", {
                  status: 503,
                  headers: { "retry-after": "Tue, 13 Oct 2026 12:00:03 GMT" },
                }),
              )
            : jsonResponse(request, 200, []),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Fiber.join(call.fiber);
        return call.requestTimes;
      }),
    );

    expect(gaps(requestTimes)).toEqual([3000]);
  });

  test.each(["soon", "-5", ""])(
    "falls back to the backoff when Retry-After is %j",
    async (retryAfter) => {
      const requestTimes = await onVirtualClock(
        Effect.gen(function* () {
          const call = yield* startVirtualCall(listProjects, (request, attempt) =>
            attempt === 1
              ? HttpClientResponse.fromWeb(
                  request,
                  new Response("{}", { status: 429, headers: { "retry-after": retryAfter } }),
                )
              : jsonResponse(request, 200, []),
          );
          yield* TestClock.adjust(Duration.minutes(1));
          yield* Fiber.join(call.fiber);
          return call.requestTimes;
        }),
      );

      expect(gaps(requestTimes)).toEqual([125]);
    },
  );

  test("returns a 429 whose Retry-After exceeds the cap without retrying", async () => {
    const { requestTimes, exit } = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(listProjects, (request) =>
          HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
          ),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        return { requestTimes: call.requestTimes, exit: yield* Fiber.join(call.fiber) };
      }),
    );

    expect(requestTimes).toHaveLength(1);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") {
      throw new Error("expected StatusCodeError");
    }
    expect(error.reason.response.status).toBe(429);
  });

  test("honours a Retry-After exactly at the cap", async () => {
    const requestTimes = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(listProjects, (request, attempt) =>
          attempt === 1
            ? HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: 429, headers: { "retry-after": "10" } }),
              )
            : jsonResponse(request, 200, []),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Fiber.join(call.fiber);
        return call.requestTimes;
      }),
    );

    expect(gaps(requestTimes)).toEqual([10_000]);
  });

  describe("per-request retry options", () => {
    const listProjectsWith = (retry: SupabaseApiRetryOptions) => (client: SupabaseApiClientShape) =>
      client.execute<"v1ListAllProjects">(operationDefinitions.v1ListAllProjects, {}, { retry });

    const failedStatus = (exit: Exit.Exit<unknown, unknown>) => {
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") {
        throw new Error("expected StatusCodeError");
      }
      return error.reason.response.status;
    };

    test("maxRetries 0 makes a single attempt and returns the 503", async () => {
      const { requestTimes, exit } = await onVirtualClock(
        Effect.gen(function* () {
          const call = yield* startVirtualCall(listProjectsWith({ maxRetries: 0 }), (request) =>
            jsonResponse(request, 503, {}),
          );
          yield* TestClock.adjust(Duration.minutes(1));
          return { requestTimes: call.requestTimes, exit: yield* Fiber.join(call.fiber) };
        }),
      );

      expect(requestTimes).toHaveLength(1);
      expect(failedStatus(exit)).toBe(503);
    });

    test("wins over the client-level retry options, field by field", async () => {
      const { requestTimes, exit } = await onVirtualClock(
        Effect.gen(function* () {
          const call = yield* startVirtualCall(
            listProjectsWith({ maxRetries: 1 }),
            (request) => jsonResponse(request, 503, {}),
            { retry: { maxRetries: 4, requestTimeoutMs: 1000 } },
          );
          yield* TestClock.adjust(Duration.minutes(1));
          return { requestTimes: call.requestTimes, exit: yield* Fiber.join(call.fiber) };
        }),
      );

      expect(requestTimes).toHaveLength(2);
      expect(failedStatus(exit)).toBe(503);
    });

    test("still applies when transformClient wraps the client", async () => {
      const { requestTimes } = await onVirtualClock(
        Effect.gen(function* () {
          const call = yield* startVirtualCall(
            listProjectsWith({ maxRetries: 0 }),
            (request) => jsonResponse(request, 503, {}),
            {
              transformClient: (client) => Effect.succeed(HttpClient.mapRequest(client, (r) => r)),
            },
          );
          yield* TestClock.adjust(Duration.minutes(1));
          yield* Fiber.join(call.fiber);
          return { requestTimes: call.requestTimes };
        }),
      );

      expect(requestTimes).toHaveLength(1);
    });

    test("requestTimeoutMs Infinity lets an attempt outlast the default timeout", async () => {
      const { attempts, exit } = await onVirtualClock(
        Effect.gen(function* () {
          let attempts = 0;
          const fiber = yield* makeSupabaseApiClient(config).pipe(
            Effect.flatMap(listProjectsWith({ requestTimeoutMs: Number.POSITIVE_INFINITY })),
            Effect.exit,
            Effect.provide(
              httpClientLayer((request) =>
                Effect.suspend(() => {
                  attempts += 1;
                  return Effect.as(
                    Effect.sleep(Duration.minutes(5)),
                    jsonResponse(request, 200, []),
                  );
                }),
              ),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.minutes(5));
          return { attempts, exit: yield* Fiber.join(fiber) };
        }),
      );

      expect(attempts).toBe(1);
      expect(exit).toEqual(Exit.succeed([]));
    });
  });

  test("does not retry a POST after a 500 however long it waits", async () => {
    const requestTimes = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(createProject, (request) =>
          jsonResponse(request, 500, {}),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Fiber.join(call.fiber);
        return call.requestTimes;
      }),
    );

    expect(requestTimes).toHaveLength(1);
  });

  test("surfaces the last 503 once a GET exhausts its retries", async () => {
    const { requestTimes, exit } = await onVirtualClock(
      Effect.gen(function* () {
        const call = yield* startVirtualCall(listProjects, (request) =>
          jsonResponse(request, 503, { message: "unavailable" }),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        return { requestTimes: call.requestTimes, exit: yield* Fiber.join(call.fiber) };
      }),
    );

    expect(requestTimes).toHaveLength(6);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(HttpClientError.isHttpClientError(error)).toBe(true);
    if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") {
      throw new Error("expected StatusCodeError");
    }
    expect(error.reason.response.status).toBe(503);
  });
});
