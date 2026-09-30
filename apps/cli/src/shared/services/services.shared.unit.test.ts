import { describe, expect, it, test } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vitest";
import serviceImagesDockerfile from "./Dockerfile" with { type: "text" };
import { dockerfileServiceImageRaw } from "./dockerfile-images.ts";
import {
  fetchLinkedServiceVersions,
  listLocalServiceVersions,
  localServiceImagesFromDockerfile,
  mergeRemoteServiceVersions,
  parseDockerfileServiceImages,
  postgresImageForDbMajorVersion,
  renderServicesTable,
  renderServicesWarning,
} from "./services.shared.ts";

// Only `auth` is pinned in this fixture catalog, at the current Dockerfile-independent version
// `v2.197.0-r0`, with a realistic (non-placeholder) fixture digest built to the real
// `ArtifactPin`/`NativePin` shape from `@supabase/stack/internal/artifacts`. Every other service
// is deliberately absent, so `toSlimImage` falls through to the upstream image for them — the
// permanent state for a non-slim-capable alias (kong, `pg14`, the job images): the Dockerfile's
// slim-capable lines are generated from the catalog now, so they never disagree with it.
// `vi.mock` factories are hoisted above every other top-level statement, so the fixture is
// inlined rather than referencing an outer const.
vi.mock("@supabase/stack/internal/artifacts", () => {
  const digest = "260e94edb8d402555791146fcf70b8e90efdc6a81877a04e5aa26f0f416a5dd7";
  const nativePin = { archive: digest, manifest: digest };
  return {
    catalogPins: () => [
      {
        service: "auth",
        sourceService: "auth",
        pin: {
          upstreamVersion: "v2.197.0",
          revision: 0,
          image: `ghcr.io/supabase/cli/auth:v2.197.0-r0@sha256:${digest}`,
          natives: {
            "darwin-arm64": nativePin,
            "linux-amd64": nativePin,
            "linux-arm64": nativePin,
          },
        },
      },
    ],
  };
});

const ACCESS_TOKEN = Redacted.make(`sbp_${"a".repeat(40)}`);
const PROJECT_REF = "abcdefghijklmnopqrst";

// `fetchLinkedServiceVersions` reads the ambient HttpClient from context instead
// of self-provisioning one, so each invocation needs a concrete transport.
const runLinkedFetch = (input: Parameters<typeof fetchLinkedServiceVersions>[0]) =>
  fetchLinkedServiceVersions(input).pipe(Effect.provide(FetchHttpClient.layer));

const serve = (options: Parameters<typeof Bun.serve>[0]) =>
  Effect.acquireRelease(
    Effect.try(() => Bun.serve(options)),
    (server) => Effect.promise(() => server.stop(true)),
  );

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

  test("derives local service versions from the Dockerfile manifest", () => {
    const rows = listLocalServiceVersions({ slim: false });
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

  test("resolves PG13/14/15 from the Dockerfile's pg15/pg14 stages, regardless of the slim flag", () => {
    const pg15 = dockerfileServiceImageRaw("pg15");
    const pg14 = dockerfileServiceImageRaw("pg14");
    expect(postgresImageForDbMajorVersion(13)).toBe(pg15);
    expect(postgresImageForDbMajorVersion(15)).toBe(pg15);
    expect(postgresImageForDbMajorVersion(14)).toBe(pg14);
    // Always the raw docker.io reference; slim translation is a separate, downstream concern
    // (`toSlimImage`/`slimImageForCurrentPin`), so this function itself doesn't read the flag.
    expect(postgresImageForDbMajorVersion(13)).toBe(pg15);
    expect(postgresImageForDbMajorVersion(15)).toBe(pg15);
    expect(postgresImageForDbMajorVersion(14)).toBe(pg14);
  });

  test("slim-translates a version override that matches a catalog pin", () => {
    expect(
      listLocalServiceVersions({ slim: true, serviceVersions: { auth: "v2.197.0" } }),
    ).toContainEqual({
      name: "ghcr.io/supabase/cli/auth",
      // The catalog's release version (`v2.197.0-r0`) is a Dockerfile/manifest tag; the row shows
      // the upstream version so a `supabase services` mismatch check compares upstream to upstream.
      local: "v2.197.0",
      remote: "",
    });
  });

  test("keeps a version override that isn't in the catalog on docker.io", () => {
    expect(
      listLocalServiceVersions({ slim: true, serviceVersions: { storage: "v1.70.3" } }),
    ).toContainEqual({
      name: "supabase/storage-api",
      local: "v1.70.3",
      remote: "",
    });
  });

  test("keeps historical pins on docker.io when slimCurrentPinOnly is set", () => {
    expect(
      listLocalServiceVersions({
        slim: true,
        slimCurrentPinOnly: true,
        serviceVersions: { pooler: "2.0.0", analytics: "1.4.0" },
      }),
    ).toEqual(
      expect.arrayContaining([
        { name: "supabase/supavisor", local: "2.0.0", remote: "" },
        { name: "supabase/logflare", local: "1.4.0", remote: "" },
      ]),
    );
  });

  test("normalizes historical pins before slimCurrentPinOnly", () => {
    expect(
      listLocalServiceVersions({
        slim: true,
        slimCurrentPinOnly: true,
        serviceVersions: { auth: "2.151.0" },
      }),
    ).toContainEqual({ name: "supabase/gotrue", local: "v2.151.0", remote: "" });
  });

  // Explicit overrides keep their registry; a serviceVersions pin still rewrites the tag.
  test("leaves explicit image overrides on docker.io when SUPABASE_USE_SLIM_IMAGES is set", () => {
    const rows = listLocalServiceVersions({
      slim: true,
      imageOverrides: {
        postgres: "supabase/postgres:15.8.1.085",
        "edge-runtime": "supabase/edge-runtime:v1.68.4",
      },
      normalizeVersionTags: false,
      serviceVersions: { postgres: "15.8.1.090" },
    });

    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "supabase/postgres", local: "15.8.1.090", remote: "" },
        { name: "supabase/edge-runtime", local: "v1.68.4", remote: "" },
      ]),
    );
  });

  // A digest-carrying override paired with a serviceVersions pin exercises the same
  // `replaceImageTag` used for the plain-tag case above; it must drop the stale digest
  // rather than splice the new tag into it (`…-r0@sha256:<pin>`).
  test("rewrites the tag on a digest-carrying image override, dropping the stale digest", () => {
    const rows = listLocalServiceVersions({
      slim: true,
      imageOverrides: {
        postgres:
          "ghcr.io/supabase/cli/postgres:17.6.1.173-r0@sha256:24e96b8d5daf90f67a62b5593d3008446744007e0a57e302d269c02a4e459e8f",
      },
      normalizeVersionTags: false,
      serviceVersions: { postgres: "17.6.1.200" },
    });

    expect(rows).toContainEqual({
      name: "ghcr.io/supabase/cli/postgres",
      local: "17.6.1.200",
      remote: "",
    });
  });

  test("can preserve raw local service version overrides", () => {
    expect(
      listLocalServiceVersions({
        slim: false,
        normalizeVersionTags: false,
        serviceVersions: {
          auth: "2.151.0",
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        name: "supabase/gotrue",
        local: "2.151.0",
      }),
    );
  });

  it.live("returns postgres only when no service-role key is available", () =>
    Effect.gen(function* () {
      const server = yield* serve({
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

      const result = yield* runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({ postgres: "17.6.1.200" });
    }),
  );

  it.live("returns no linked versions when project api keys cannot be loaded", () =>
    Effect.gen(function* () {
      const server = yield* serve({
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

      const result = yield* runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({});
    }),
  );

  it.live("still returns tenant service versions when project version lookup fails", () =>
    Effect.gen(function* () {
      const server = yield* serve({
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

      const result = yield* runLinkedFetch({
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
    }),
  );

  it.live("keeps an already-prefixed tenant version, including uppercase V", () =>
    Effect.gen(function* () {
      const server = yield* serve({
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
            return Response.json({ info: { version: "V14.13" } });
          }

          if (url.pathname === "/storage/v1/version") {
            return new Response("v1.77.1-versions");
          }

          return new Response("not found", { status: 404 });
        },
      });

      const result = yield* runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
        tenantBaseUrlOverride: server.url.origin,
      });

      expect(result).toEqual({
        auth: "v2.190.0",
        postgrest: "V14.13",
        storage: "v1.77.1-versions",
      });
    }),
  );

  it.live("falls back to empty linked versions when the linked fetch fails", () =>
    Effect.gen(function* () {
      const result = yield* runLinkedFetch({
        apiUrl: "http://127.0.0.1:1",
        projectHost: "supabase.co",
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
      });

      expect(result).toEqual({});
    }),
  );

  it.live("authenticates tenant probes with apikey only for sb_ keys", () =>
    Effect.gen(function* () {
      const authHeaders: Record<string, string | null> = {};
      const server = yield* serve({
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

      const result = yield* runLinkedFetch({
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
    }),
  );

  it.live("skips remote lookups for a malformed project ref", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        port: 0,
        fetch() {
          throw new Error("no request should be made for a malformed project ref");
        },
      });

      const result = yield* runLinkedFetch({
        apiUrl: server.url.origin,
        projectHost: "supabase.co",
        projectRef: "not-a-valid-ref",
        accessToken: ACCESS_TOKEN,
        userAgent: "supabase",
      });

      expect(result).toEqual({});
    }),
  );

  test("renders the local services table with expected headers and rows", () => {
    const rows = listLocalServiceVersions({ slim: false });
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

  test("compares upstream versions for a slim catalog pin, not the release tag", () => {
    const rows = mergeRemoteServiceVersions(
      { auth: "v2.197.0" },
      { slim: true, serviceVersions: { auth: "v2.197.0" } },
    );

    expect(rows).toContainEqual({
      name: "ghcr.io/supabase/cli/auth",
      local: "v2.197.0",
      remote: "v2.197.0",
    });
    // The pinned image's release tag (`v2.197.0-r0@sha256:…`) never surfaces as a mismatch
    // against the upstream-only remote version.
    expect(renderServicesWarning(rows)).toBeUndefined();
  });
});
