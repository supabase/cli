import { describe, expect, test } from "vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { makeApiClient } from "./effect.ts";

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

function requestBodyText(request: HttpClientRequest.HttpClientRequest): string {
  if (request.body._tag !== "Uint8Array") {
    throw new Error(`Expected Uint8Array body, got ${request.body._tag}`);
  }
  return textDecoder.decode(request.body.body);
}

const config = {
  baseUrl: "https://api.supabase.com",
  accessToken: "test-token",
  userAgent: "supabase-api/test",
} as const;

describe("makeApiClient", () => {
  test("uses the default API URL when baseUrl is omitted", async () => {
    const seenRequests: Array<{ method: string; url: string }> = [];

    const client = await Effect.runPromise(
      makeApiClient({ accessToken: "test-token" }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequests.push({
              method: request.method,
              url: request.url,
            });
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

    await Effect.runPromise(
      client.v1.getProject({
        ref: "abcdefghijklmnopqrst",
      }),
    );

    expect(seenRequests).toEqual([
      {
        method: "GET",
        url: "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst",
      },
    ]);
  });

  test("reads the access token from the environment when omitted", async () => {
    const seenRequests: Array<{ authorization: string | undefined }> = [];

    const client = await Effect.runPromise(
      makeApiClient().pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequests.push({
              authorization: request.headers.authorization,
            });
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
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SUPABASE_ACCESS_TOKEN: "env-token",
            }),
          ),
        ),
      ),
    );

    await Effect.runPromise(
      client.v1.getProject({
        ref: "abcdefghijklmnopqrst",
      }),
    );

    expect(seenRequests).toEqual([{ authorization: "Bearer env-token" }]);
  });

  test("passes configured default headers through the facade client", async () => {
    const seenRequests: Array<{
      command: string | undefined;
      commandRunId: string | undefined;
      authorization: string | undefined;
    }> = [];

    const client = await Effect.runPromise(
      makeApiClient({
        ...config,
        headers: {
          "X-Supabase-Command": "projects get",
          "X-Supabase-Command-Run-ID": "run-456",
        },
      }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequests.push({
              command: request.headers["x-supabase-command"],
              commandRunId: request.headers["x-supabase-command-run-id"],
              authorization: request.headers.authorization,
            });
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

    await Effect.runPromise(
      client.v1.getProject({
        ref: "abcdefghijklmnopqrst",
      }),
    );

    expect(seenRequests).toEqual([
      {
        command: "projects get",
        commandRunId: "run-456",
        authorization: "Bearer test-token",
      },
    ]);
  });

  test("fails early when no access token is configured", async () => {
    const exit = await Effect.runPromise(
      makeApiClient().pipe(
        Effect.exit,
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              jsonResponse(request, 200, {
                ok: true,
              }),
            ),
          ),
        ),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("Missing access token");
    }
  });

  test("returns only versioned methods under the v1 namespace", async () => {
    const seenRequests: Array<{ method: string; url: string }> = [];

    const client = await Effect.runPromise(
      makeApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequests.push({
              method: request.method,
              url: request.url,
            });

            if (
              request.method === "POST" &&
              request.url === "https://api.supabase.com/v1/projects"
            ) {
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
            }

            if (
              request.method === "GET" &&
              request.url === "https://api.supabase.com/v1/projects"
            ) {
              return Effect.succeed(
                jsonResponse(request, 200, [
                  {
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
                  },
                ]),
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

    expect("createAProject" in client).toBe(false);
    expect("getProject" in client).toBe(false);
    expect("listAllProjects" in client).toBe(false);
    expect(typeof client.v1.createAProject).toBe("function");
    expect(typeof client.v1.getProject).toBe("function");
    expect(typeof client.v1.listAllProjects).toBe("function");

    const created = await Effect.runPromise(
      client.v1.createAProject({
        db_pass: "hunter2",
        name: "project-name",
        organization_slug: "my-org",
      }),
    );
    const project = await Effect.runPromise(
      client.v1.getProject({
        ref: "abcdefghijklmnopqrst",
      }),
    );
    const projects = await Effect.runPromise(client.v1.listAllProjects());

    expect(created.ref).toBe("abcdefghijklmnopqrst");
    expect(project.database.host).toBe("db.supabase.internal");
    expect(projects).toHaveLength(1);
    expect(seenRequests).toEqual([
      {
        method: "POST",
        url: "https://api.supabase.com/v1/projects",
      },
      {
        method: "GET",
        url: "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst",
      },
      {
        method: "GET",
        url: "https://api.supabase.com/v1/projects",
      },
    ]);
  });

  test("serializes generated binary methods through the effect facade", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const client = await Effect.runPromise(
      makeApiClient(config).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            seenRequest = request;
            return Effect.succeed(
              jsonResponse(request, 201, {
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
              }),
            );
          }),
        ),
      ),
    );

    const body = new Blob(["console.log('blob body');"]);
    const result = await Effect.runPromise(
      client.v1.createAFunction({
        ref: "abcdefghijklmnopqrst",
        slug: "demo",
        verify_jwt: true,
        entrypoint_path: "functions/demo/index.ts",
        body,
      }),
    );

    expect(result.slug).toBe("demo");
    expect(seenRequest?.headers["content-type"]).toBe("application/vnd.denoland.eszip");
    expect(new URL(seenRequest!.url).pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions");
    expect(requestBodyText(seenRequest!)).toBe("console.log('blob body');");
  });
});
