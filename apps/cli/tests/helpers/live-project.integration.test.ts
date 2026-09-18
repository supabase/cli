import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { afterEach, describe, expect, it, vi } from "vitest";

import { provisionLiveEnvironment } from "./live-project.ts";

const ref = "abcdefghijklmnopqrst";
function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

const project = {
  id: "1",
  ref,
  organization_id: "org-id",
  organization_slug: "org-slug",
  name: "live-test",
  region: "us-east-1",
  created_at: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE_HEALTHY" as const,
  database: {
    host: `db.${ref}.supabase.green`,
    version: "17",
    postgres_engine: "17",
    release_channel: "stable",
  },
};

type ApiKeyScenario = {
  name: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

describe("live project provisioning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<ApiKeyScenario>([
    {
      name: "terminal API key rejection",
      status: 403,
      body: { message: "authorization denied", access_token: "secret-value" },
      headers: { "x-request-id": "req-live-403" },
    },
    {
      name: "malformed HTTP 200 API key response",
      status: 200,
      body: "sentinel-secret",
      headers: {},
    },
  ])("redacts $name while cleaning up", async ({ status, body, headers }) => {
    vi.stubEnv("SUPABASE_LIVE_API_URL", "https://api.supabase.green");
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "test-token");
    vi.stubEnv("SUPABASE_LIVE_ORG_ID", "org-slug");
    vi.stubEnv("SUPABASE_LIVE_REGION", "us-east-1");
    vi.stubEnv("SUPABASE_LIVE_KEEP_PROJECT", "0");

    const requests: string[] = [];
    const ownedProjects = new Set<string>();
    const client = await Effect.runPromise(
      makeApiClient({ baseUrl: "https://api.supabase.green", accessToken: "test-token" }).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const url = new URL(request.url);
              requests.push(`${request.method} ${url.pathname}`);
              if (request.method === "GET" && url.pathname === "/v1/organizations") {
                return Effect.succeed(
                  jsonResponse(request, 200, [{ id: "org-id", slug: "org-slug", name: "Test" }]),
                );
              }
              if (request.method === "POST" && url.pathname === "/v1/projects") {
                ownedProjects.add(ref);
                return Effect.succeed(
                  jsonResponse(request, 201, { ...project, database: undefined }),
                );
              }
              if (request.method === "GET" && url.pathname === `/v1/projects/${ref}`) {
                return Effect.succeed(jsonResponse(request, 200, project));
              }
              if (request.method === "GET" && url.pathname === `/v1/projects/${ref}/api-keys`) {
                return Effect.succeed(jsonResponse(request, status, body, headers));
              }
              if (request.method === "DELETE" && url.pathname === `/v1/projects/${ref}`) {
                ownedProjects.delete(ref);
                return Effect.succeed(
                  jsonResponse(request, 200, { id: 1, ref, name: "live-test" }),
                );
              }
              return Effect.die(`unexpected request ${request.method} ${url.pathname}`);
            }),
          ),
        ),
      ),
    );

    let failure: unknown;
    try {
      await Effect.runPromise(provisionLiveEnvironment(client));
    } catch (error) {
      failure = error;
    }
    if (status === 403) {
      expect(String(failure)).toMatch(
        /project API keys failed: GET \/v1\/projects\/abcdefghijklmnopqrst\/api-keys returned HTTP 403.*x-request-id=req-live-403.*response body omitted/,
      );
    } else {
      expect(String(failure)).toContain(
        "project API keys failed: management API response schema validation failed",
      );
    }
    expect(requests.filter((request) => request.includes("/api-keys"))).toHaveLength(1);
    expect(requests).toContain("DELETE /v1/projects/abcdefghijklmnopqrst");
    expect(ownedProjects).toEqual(new Set());
    const message = String(failure);
    expect(message).not.toContain("test-token");
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("authorization denied");
    expect(message).not.toContain("sentinel-secret");
  });
});
