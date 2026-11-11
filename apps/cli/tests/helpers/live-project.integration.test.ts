import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Cause, Effect, Exit, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cliConfigProviderLayer } from "../../src/shared/config/cli-config-provider.layer.ts";
import { cleanupLiveEnvironment, provisionLiveEnvironment } from "./live-project.ts";

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
  ])("redacts $name while cleaning up", ({ status, body, headers }) => {
    vi.stubEnv("SUPABASE_LIVE_API_URL", "https://api.supabase.green");
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "test-token");
    vi.stubEnv("SUPABASE_LIVE_ORG_ID", "org-slug");
    vi.stubEnv("SUPABASE_LIVE_REGION", "us-east-1");
    vi.stubEnv("SUPABASE_LIVE_KEEP_PROJECT", "0");

    const requests: string[] = [];
    const ownedProjects = new Set<string>();
    const platformApi = Layer.succeed(
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
          return Effect.succeed(jsonResponse(request, 201, { ...project, database: undefined }));
        }
        if (request.method === "GET" && url.pathname === `/v1/projects/${ref}`) {
          return Effect.succeed(jsonResponse(request, 200, project));
        }
        if (request.method === "GET" && url.pathname === `/v1/projects/${ref}/api-keys`) {
          return Effect.succeed(jsonResponse(request, status, body, headers));
        }
        if (request.method === "DELETE" && url.pathname === `/v1/projects/${ref}`) {
          ownedProjects.delete(ref);
          return Effect.succeed(jsonResponse(request, 200, { id: 1, ref, name: "live-test" }));
        }
        return Effect.die(`unexpected request ${request.method} ${url.pathname}`);
      }),
    );

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeApiClient({
          baseUrl: "https://api.supabase.green",
          accessToken: "test-token",
        });

        const exit = yield* Effect.exit(provisionLiveEnvironment(client));
        const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
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
      }).pipe(
        Effect.provide(
          Layer.mergeAll(platformApi, BunFileSystem.layer, BunPath.layer, cliConfigProviderLayer),
        ),
      ),
    );
  });

  it("provisions with the new API keys when the project's legacy keys are disabled", () => {
    vi.stubEnv("SUPABASE_LIVE_API_URL", "https://api.supabase.green");
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "test-token");
    vi.stubEnv("SUPABASE_LIVE_ORG_ID", "org-slug");
    vi.stubEnv("SUPABASE_LIVE_REGION", "us-east-1");
    vi.stubEnv("SUPABASE_LIVE_KEEP_PROJECT", "0");

    const bucketApiKeys: Array<string | undefined> = [];
    const ownedProjects = new Set<string>();
    const platformApi = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/organizations") {
          return Effect.succeed(
            jsonResponse(request, 200, [{ id: "org-id", slug: "org-slug", name: "Test" }]),
          );
        }
        if (request.method === "POST" && url.pathname === "/v1/projects") {
          ownedProjects.add(ref);
          return Effect.succeed(jsonResponse(request, 201, { ...project, database: undefined }));
        }
        if (request.method === "GET" && url.pathname === `/v1/projects/${ref}`) {
          return Effect.succeed(jsonResponse(request, 200, project));
        }
        if (request.method === "GET" && url.pathname === `/v1/projects/${ref}/api-keys`) {
          return Effect.succeed(
            jsonResponse(request, 200, [
              { name: "anon", type: "legacy", api_key: "legacy-anon-jwt" },
              { name: "service_role", type: "legacy", api_key: "legacy-service-role-jwt" },
              { name: "default", type: "publishable", api_key: "sb_publishable_live" },
              {
                name: "default",
                type: "secret",
                api_key: "sb_secret_live",
                secret_jwt_template: { role: "service_role" },
              },
            ]),
          );
        }
        if (
          request.method === "GET" &&
          url.pathname === `/v1/projects/${ref}/config/database/pooler`
        ) {
          return Effect.succeed(
            jsonResponse(request, 200, [
              {
                identifier: "primary",
                database_type: "PRIMARY",
                is_using_scram_auth: false,
                db_user: `postgres.${ref}`,
                db_host: "aws-0-us-east-1.pooler.supabase.green",
                db_port: 6543,
                db_name: "postgres",
                connection_string: `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.green:6543/postgres`,
                connectionString: "",
                default_pool_size: null,
                max_client_conn: null,
                pool_mode: "transaction",
              },
            ]),
          );
        }
        if (
          request.method === "POST" &&
          url.href === `https://${ref}.supabase.green/storage/v1/bucket`
        ) {
          const apiKey = request.headers["apikey"];
          bucketApiKeys.push(apiKey);
          return Effect.succeed(
            apiKey === "sb_secret_live"
              ? jsonResponse(request, 200, { name: "supabase-cli-live-bucket" })
              : jsonResponse(request, 401, { message: "Legacy API keys are disabled" }),
          );
        }
        if (request.method === "DELETE" && url.pathname === `/v1/projects/${ref}`) {
          ownedProjects.delete(ref);
          return Effect.succeed(jsonResponse(request, 200, { id: 1, ref, name: "live-test" }));
        }
        return Effect.die(`unexpected request ${request.method} ${url.href}`);
      }),
    );

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeApiClient({
          baseUrl: "https://api.supabase.green",
          accessToken: "test-token",
        });

        const environment = yield* provisionLiveEnvironment(client);
        yield* cleanupLiveEnvironment(client, environment);

        expect(environment.project).toMatchObject({
          anonKey: "sb_publishable_live",
          serviceRoleKey: "sb_secret_live",
        });
        expect(bucketApiKeys).toEqual(["sb_secret_live"]);
        expect(ownedProjects).toEqual(new Set());
      }).pipe(
        Effect.provide(
          Layer.mergeAll(platformApi, BunFileSystem.layer, BunPath.layer, cliConfigProviderLayer),
        ),
      ),
    );
  });
});
