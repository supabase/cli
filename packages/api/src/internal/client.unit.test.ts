import { describe, expect, test } from "vitest";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as UrlParams from "effect/unstable/http/UrlParams";
import * as Schema from "effect/Schema";

import { operationDefinitions } from "../generated/contracts.ts";
import { makeSupabaseApiClient } from "./client.ts";

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

describe("makeSupabaseApiClient", () => {
  test("retries transport errors for POST requests", async () => {
    let attempts = 0;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, {
            db_pass: "hunter2",
            name: "project-name",
            organization_slug: "my-org",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            attempts += 1;
            if (attempts < 3) {
              return Effect.fail(transportError(request, "socket reset"));
            }

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

    expect(attempts).toBe(3);
    expect(result.ref).toBe("abcdefghijklmnopqrst");
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

  test("retries 5xx responses for idempotent GET requests", async () => {
    let attempts = 0;

    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1GetProject">(operationDefinitions.v1GetProject, {
            ref: "abcdefghijklmnopqrst",
          }),
        ),
        Effect.provide(
          httpClientLayer((request) => {
            attempts += 1;
            if (attempts === 1) {
              return Effect.succeed(
                jsonResponse(request, 500, {
                  error: "temporary failure",
                }),
              );
            }

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
                database: {
                  host: "db.supabase.internal",
                  version: "17.0.1",
                  postgres_engine: "17",
                  release_channel: "ga",
                },
              }),
            );
          }),
        ),
      ),
    );

    expect(attempts).toBe(2);
    expect(result.database.host).toBe("db.supabase.internal");
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

  test("stops after the configured number of transport retries", async () => {
    let attempts = 0;

    const exit = await Effect.runPromise(
      makeSupabaseApiClient(config, {
        retry: {
          maxRetries: 2,
        },
      }).pipe(
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
            return Effect.fail(transportError(request, "still broken"));
          }),
        ),
      ),
    );

    expect(attempts).toBe(3);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("decodes text responses through the unified execute path", async () => {
    const result = await Effect.runPromise(
      makeSupabaseApiClient(config).pipe(
        Effect.flatMap((client) =>
          client.execute<"v1DiffABranch">(operationDefinitions.v1DiffABranch, {
            branch_id_or_ref: "branch-ref",
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
              client_id: "11111111-1111-1111-1111-111111111111",
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
    expect(body.get("client_id")).toBe("11111111-1111-1111-1111-111111111111");
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
});
