import { describe, expect, test } from "vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import serviceImagesDockerfile from "../../../../cli-go/pkg/config/templates/Dockerfile" with { type: "text" };
import {
  fetchLinkedServiceVersions,
  listLocalServiceVersions,
  localServiceImagesFromDockerfile,
  parseDockerfileServiceImages,
  renderServicesTable,
  renderServicesWarning,
} from "./services.shared.ts";

const ACCESS_TOKEN = Redacted.make(`sbp_${"a".repeat(40)}`);
const PROJECT_REF = "abcdefghijklmnopqrst";

// `fetchLinkedServiceVersions` reads the ambient HttpClient from context instead
// of self-provisioning one, so each invocation needs a concrete transport.
const runLinkedFetch = (input: Parameters<typeof fetchLinkedServiceVersions>[0]) =>
  Effect.runPromise(fetchLinkedServiceVersions(input).pipe(Effect.provide(FetchHttpClient.layer)));

describe("services shared", () => {
  test("parses service images from Dockerfile FROM aliases", () => {
    expect(
      parseDockerfileServiceImages(`
        # comment
        FROM supabase/postgres:17.6.1.132 AS pg

        RUN echo ignored
        FROM localhost:5000/custom/image:1.2.3 AS custom
      `),
    ).toEqual([
      { alias: "pg", image: "supabase/postgres:17.6.1.132" },
      { alias: "custom", image: "localhost:5000/custom/image:1.2.3" },
    ]);
  });

  test("fails clearly when the Dockerfile manifest misses a required service alias", () => {
    expect(() =>
      localServiceImagesFromDockerfile("FROM supabase/postgres:17.6.1.132 AS pg\n"),
    ).toThrow("Missing service image alias 'gotrue' in Dockerfile manifest.");
  });

  test("derives local service versions from the Go Dockerfile manifest", () => {
    const rows = listLocalServiceVersions();
    const dockerfileImages = localServiceImagesFromDockerfile(serviceImagesDockerfile);
    const expectedRows = dockerfileImages.map((service) => {
      const tagSeparator = service.image.lastIndexOf(":");
      return {
        name: service.image.slice(0, tagSeparator),
        local: service.image.slice(tagSeparator + 1),
        remote: "",
      };
    });

    expect(rows).toEqual(expectedRows);
    expect(rows.map((row) => row.name)).toEqual([
      "supabase/postgres",
      "supabase/gotrue",
      "postgrest/postgrest",
      "supabase/realtime",
      "supabase/storage-api",
      "supabase/edge-runtime",
      "supabase/studio",
      "supabase/postgres-meta",
      "supabase/logflare",
      "supabase/supavisor",
    ]);
  });

  test("returns postgres only when no service-role key is available", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${PROJECT_REF}`) {
          return Response.json({
            id: PROJECT_REF,
            ref: PROJECT_REF,
            organization_id: "org-id",
            organization_slug: "org",
            name: "Linked Project",
            region: "us-east-1",
            created_at: "2026-03-13T12:00:00.000Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.supabase.internal",
              version: "17.6.1.200",
              postgres_engine: "17",
              release_channel: "ga",
            },
          });
        }

        if (url.pathname === `/v1/projects/${PROJECT_REF}/api-keys`) {
          return Response.json([
            {
              name: "anon",
              id: "publishable-id",
              type: "publishable",
              api_key: "publishable-key",
              description: null,
            },
          ]);
        }

        if (
          url.pathname === "/auth/v1/health" ||
          url.pathname === "/rest/v1/" ||
          url.pathname === "/storage/v1/version"
        ) {
          throw new Error(
            `tenant endpoint should not be called without a service-role key: ${url.pathname}`,
          );
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({ postgres: "17.6.1.200" });
    } finally {
      await server.stop(true);
    }
  });

  test("returns no linked versions when project api keys cannot be loaded", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${PROJECT_REF}/api-keys`) {
          return new Response("boom", { status: 500 });
        }

        if (url.pathname === `/v1/projects/${PROJECT_REF}`) {
          return Response.json({
            id: PROJECT_REF,
            ref: PROJECT_REF,
            organization_id: "org-id",
            organization_slug: "org",
            name: "Linked Project",
            region: "us-east-1",
            created_at: "2026-03-13T12:00:00.000Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.supabase.internal",
              version: "17.6.1.200",
              postgres_engine: "17",
              release_channel: "ga",
            },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({});
    } finally {
      await server.stop(true);
    }
  });

  test("still returns tenant service versions when project version lookup fails", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${PROJECT_REF}`) {
          return new Response("boom", { status: 500 });
        }

        if (url.pathname === `/v1/projects/${PROJECT_REF}/api-keys`) {
          return Response.json([
            {
              name: "service_role",
              id: "key-id",
              type: "secret",
              api_key: "service-role-key",
              description: null,
              secret_jwt_template: { role: "service_role" },
            },
          ]);
        }

        if (url.pathname === "/auth/v1/health") {
          return Response.json({ version: "v2.190.0" });
        }

        if (url.pathname === "/rest/v1/") {
          return Response.json({ info: { version: "14.13" } });
        }

        if (url.pathname === "/storage/v1/version") {
          return new Response("1.61.0");
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({
        auth: "v2.190.0",
        postgrest: "v14.13",
        storage: "v1.61.0",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("falls back to empty linked versions when the linked fetch fails", async () => {
    const result = await runLinkedFetch({
      apiUrl: "http://127.0.0.1:1",
      projectHost: "supabase.co",
      projectRef: PROJECT_REF,
      accessToken: ACCESS_TOKEN,
      userAgent: "supabase",
    });

    expect(result).toEqual({});
  });

  test("authenticates tenant probes with apikey only for sb_ keys", async () => {
    const authHeaders: Record<string, string | null> = {};
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${PROJECT_REF}/api-keys`) {
          return Response.json([
            {
              name: "service_role",
              id: "key-id",
              type: "secret",
              api_key: "sb_secret_servicerolekey",
              description: null,
              secret_jwt_template: { role: "service_role" },
            },
          ]);
        }

        if (url.pathname === `/v1/projects/${PROJECT_REF}`) {
          return new Response("boom", { status: 500 });
        }

        if (url.pathname === "/auth/v1/health") {
          authHeaders.apikey = request.headers.get("apikey");
          authHeaders.authorization = request.headers.get("authorization");
          return Response.json({ version: "v2.190.0" });
        }

        if (url.pathname === "/rest/v1/" || url.pathname === "/storage/v1/version") {
          return new Response("not found", { status: 404 });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({ auth: "v2.190.0" });
      expect(authHeaders.apikey).toBe("sb_secret_servicerolekey");
      expect(authHeaders.authorization).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("skips remote lookups for a malformed project ref", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        throw new Error("no request should be made for a malformed project ref");
      },
    });

    try {
      const result = await runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: "not-a-valid-ref",
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
      });

      expect(result).toEqual({});
    } finally {
      await server.stop(true);
    }
  });

  test("renders the local services table with expected headers and rows", () => {
    const rows = listLocalServiceVersions();
    const table = renderServicesTable(rows);

    expect(table).toContain("SERVICE IMAGE");
    expect(table).toContain("LOCAL");
    expect(table).toContain("LINKED");

    for (const row of rows) {
      expect(table).toContain(row.name);
      expect(table).toContain(row.local);
    }
  });

  test("renders update warning only for mismatched linked versions", () => {
    expect(
      renderServicesWarning([
        { name: "supabase/postgres", local: "17.6.1.132", remote: "17.6.1.200" },
        { name: "supabase/gotrue", local: "v2.189.0", remote: "v2.189.0" },
      ]),
    ).toContain("supabase/postgres:17.6.1.132 => 17.6.1.200");
  });
});
