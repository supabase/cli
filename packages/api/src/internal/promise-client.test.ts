import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as UrlParams from "effect/unstable/http/UrlParams";

import { makeApiClient } from "../effect.ts";
import { makePromiseClient } from "./promise-client.ts";

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

const config = {
  baseUrl: "https://api.supabase.com",
  accessToken: "test-token",
  userAgent: "supabase-api/test",
} as const;

describe("makePromiseClient", () => {
  test("preserves the unversioned facade and the v1 namespace", async () => {
    const seenRequests: Array<{ method: string; url: string }> = [];
    const runtime = ManagedRuntime.make(
      httpClientLayer((request) => {
        seenRequests.push({
          method: request.method,
          url: request.url,
        });

        if (request.method === "POST" && request.url === "https://api.supabase.com/v1/projects") {
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

        if (request.method === "GET" && request.url === "https://api.supabase.com/v1/projects") {
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
    );

    try {
      const effectClient = await runtime.runPromise(makeApiClient(config));
      const { v1, ...unversioned } = effectClient;
      const client = {
        ...makePromiseClient(runtime, unversioned),
        v1: makePromiseClient(runtime, v1),
      };

      expect(Object.keys(client)).toContain("createAProject");
      expect(Object.keys(client)).toContain("getProject");
      expect(Object.keys(client)).toContain("listAllProjects");
      expect(typeof client.v1.createAProject).toBe("function");
      expect(typeof client.v1.getProject).toBe("function");
      expect(typeof client.v1.listAllProjects).toBe("function");

      const created = await client.createAProject({
        db_pass: "hunter2",
        name: "project-name",
        organization_slug: "my-org",
      });
      const project = await client.v1.getProject({
        ref: "abcdefghijklmnopqrst",
      });
      const projects = await client.listAllProjects();

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
    } finally {
      await runtime.dispose();
    }
  });

  test("serializes generated multipart methods through the promise facade", async () => {
    let seenRequest: HttpClientRequest.HttpClientRequest | undefined;

    const runtime = ManagedRuntime.make(
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
          }),
        );
      }),
    );

    try {
      const effectClient = await runtime.runPromise(makeApiClient(config));
      const { v1, ...unversioned } = effectClient;
      const client = {
        ...makePromiseClient(runtime, unversioned),
        v1: makePromiseClient(runtime, v1),
      };

      const metadata = {
        entrypoint_path: "functions/demo/index.ts",
        import_map_path: "functions/demo/deno.json",
        verify_jwt: true,
        name: "demo",
      } as const;

      const result = await client.v1.deployAFunction({
        ref: "abcdefghijklmnopqrst",
        slug: "demo",
        bundleOnly: true,
        body: {
          metadata,
          file: [new Uint8Array([1, 2, 3]), new Blob(["deno.json"])],
        },
      });

      expect(result.slug).toBe("demo");
      expect(new URL(seenRequest!.url).pathname).toBe(
        "/v1/projects/abcdefghijklmnopqrst/functions/deploy",
      );
      expect(requestUrlParam(seenRequest!, "slug")).toBe("demo");
      expect(requestUrlParam(seenRequest!, "bundleOnly")).toBe("true");

      const formData = requestFormData(seenRequest!);
      expect(JSON.parse(formDataTextValue(formData, "metadata"))).toEqual(metadata);
      expect(await formDataFileTexts(formData, "file")).toEqual([
        "\u0001\u0002\u0003",
        "deno.json",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
