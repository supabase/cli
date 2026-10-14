import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

import { withEnvVar } from "../../tests/helpers/command-mocks.ts";
import caProd2021 from "../commands/gen/types/templates/prod-ca-2021.ts";
import {
  KONG_LOCAL_TLS_CERT,
  KONG_LOCAL_TLS_KEY,
} from "../commands/start/templates/kong-local-tls.ts";
import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import { KONG_LOCAL_CA_CERT } from "./kong-local-ca-cert.ts";
import { withStorageGatewayFetch } from "./storage-credentials.ts";
import { StorageGatewayNetworkError, StorageGatewayStatusError } from "./storage-gateway.errors.ts";
import { bucketBody, makeStorageGateway } from "./storage-gateway.ts";

describe("bucketBody", () => {
  it("omits public when undefined (Go *bool nil / omitempty)", () => {
    expect(bucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({});
  });

  it("includes public when explicitly set (true or false)", () => {
    expect(bucketBody({ public: true, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: true,
    });
    expect(bucketBody({ public: false, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: false,
    });
  });

  it("includes file_size_limit and allowed_mime_types only when non-empty", () => {
    expect(
      bucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] }),
    ).not.toHaveProperty("file_size_limit");
    expect(
      bucketBody({
        public: false,
        fileSizeLimit: 52_428_800,
        allowedMimeTypes: ["image/png"],
      }),
    ).toEqual({ public: false, file_size_limit: 52_428_800, allowed_mime_types: ["image/png"] });
  });
});

describe("StorageGatewayStatusError actionability", () => {
  it("keeps a shared gateway 404 on API status because the tag also wraps capability probes", () => {
    const result = classifyCliErrorActionability(
      new StorageGatewayStatusError({ status: 404, body: "ignored", message: "ignored" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:StorageGatewayStatusError:api_status");
  });
});

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

function setup(
  routes: ReadonlyArray<{ match: string; status?: number; body?: unknown; raw?: string }>,
) {
  const requests: Recorded[] = [];
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      let body: unknown;
      if (request.body._tag === "Uint8Array") {
        try {
          body = JSON.parse(new TextDecoder().decode(request.body.body));
        } catch {
          body = undefined;
        }
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });
      const route = routes.find((r) => request.url.includes(r.match));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(route?.raw ?? JSON.stringify(route?.body ?? {}), {
            status: route?.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  return { requests, layer: Layer.mergeAll(httpLayer, BunServices.layer) };
}

describe("makeStorageGateway", () => {
  it.live("decodes a list with a null id as a directory", () => {
    const { requests, layer } = setup([
      {
        match: "/storage/v1/object/list/private",
        body: [
          { name: "folder", id: null },
          { name: "file.png", id: "9b7f9f48" },
        ],
      },
    ]);
    return Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "service-key",
        userAgent: "SupabaseCLI/test",
      });
      const objects = yield* gateway.listObjects("private", "folder/name", 1);
      expect(objects).toEqual([
        { name: "folder", isDir: true },
        { name: "file.png", isDir: false },
      ]);
      // path.Split("folder/name") → prefix "folder/", search "name"; page 1 → offset 100.
      expect(requests[0]?.body).toEqual({
        prefix: "folder/",
        search: "name",
        limit: 100,
        offset: 100,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends only apikey for an opaque sb_ key, both headers for a JWT", () => {
    const { requests, layer } = setup([{ match: "/storage/v1/bucket", body: [] }]);
    return Effect.gen(function* () {
      const opaque = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "sb_secret_local",
        userAgent: "ua",
      });
      yield* opaque.listBuckets;
      expect(requests[0]?.headers["apikey"]).toBe("sb_secret_local");
      expect(requests[0]?.headers["authorization"]).toBeUndefined();

      const jwt = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "ey.jwt.key",
        userAgent: "ua",
      });
      yield* jwt.listBuckets;
      expect(requests[1]?.headers["authorization"]).toBe("Bearer ey.jwt.key");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a non-200 to a status error carrying the body", () => {
    const { layer } = setup([
      { match: "/storage/v1/object/move", status: 404, body: { error: "not_found" } },
    ]);
    return Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "k",
        userAgent: "ua",
      });
      const error = yield* gateway.moveObject("private", "a", "b").pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageGatewayStatusError);
      expect(error.message).toBe('Error status 404: {"error":"not_found"}');
      // The raw response body is carried on the status error for caller classification.
      expect(error).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a 200 body that is not JSON as a response decode error", () => {
    const { layer } = setup([{ match: "/storage/v1/bucket", raw: "<html>gateway</html>" }]);
    return Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "k",
        userAgent: "ua",
      });
      const error = yield* gateway.listBuckets.pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageGatewayNetworkError);
      expect(error).toMatchObject({
        message: "failed to parse response body: Expected a valid JSON string",
        decode: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the prefixes body for deleteObjects and decodes removed names", () => {
    const { requests, layer } = setup([
      { match: "/storage/v1/object/private", body: [{ name: "a.txt" }, { name: "b.txt" }] },
    ]);
    return Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "k",
        userAgent: "ua",
      });
      const removed = yield* gateway.deleteObjects("private", ["a.txt", "b.txt"]);
      expect(removed).toEqual([{ name: "a.txt" }, { name: "b.txt" }]);
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.body).toEqual({ prefixes: ["a.txt", "b.txt"] });
    }).pipe(Effect.provide(layer));
  });
});

describe("withStorageGatewayFetch", () => {
  // Stands in for the shared DNS-over-HTTPS fetch that gateway calls bypass.
  const dohFetch: typeof globalThis.fetch = Object.assign(
    () => Promise.resolve(Response.json([{ name: "via-doh", id: "via-doh" }])),
    { preconnect: () => Promise.resolve() },
  );
  // Bun reads NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR at startup, so withEnvVar
  // cannot scrub them.
  const trustedWith = (ca: string) => (buckets: ReadonlyArray<{ readonly name: string }>) =>
    Effect.die(
      new Error(
        `call with ${ca} returned ${buckets.map(({ name }) => name).join(", ")} instead of a TLS rejection: via-doh means the DoH fetch was not bypassed; avatars means a regression or an ambient NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/SSL_CERT_DIR trusting the Kong CA`,
      ),
    );

  it.effect(
    "trusts only the local Kong CA over plain fetch and rejects the self-signed gateway without it",
    () =>
      // An ambient NODE_TLS_REJECT_UNAUTHORIZED=0 would make Bun accept the untrusted gateway.
      withEnvVar(
        "NODE_TLS_REJECT_UNAUTHORIZED",
        undefined,
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.try(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                tls: { cert: KONG_LOCAL_TLS_CERT, key: KONG_LOCAL_TLS_KEY },
                fetch: () => Response.json([{ name: "avatars", id: "avatars" }]),
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          );
          const gateway = yield* makeStorageGateway({
            baseUrl: `https://127.0.0.1:${server.port}`,
            apiKey: "k",
            userAgent: "ua",
          });

          const rejected = yield* gateway.listBuckets.pipe(
            withStorageGatewayFetch(undefined),
            Effect.flip,
            Effect.catch(trustedWith("no CA")),
          );
          expect(rejected).toBeInstanceOf(StorageGatewayNetworkError);

          // Before the trusted call, so a pooled verified connection cannot mask it.
          const wrongCa = yield* gateway.listBuckets.pipe(
            withStorageGatewayFetch(caProd2021),
            Effect.flip,
            Effect.catch(trustedWith("the prod 2021 CA")),
          );
          expect(wrongCa).toBeInstanceOf(StorageGatewayNetworkError);

          const buckets = yield* gateway.listBuckets.pipe(
            withStorageGatewayFetch(KONG_LOCAL_CA_CERT),
          );
          expect(buckets).toEqual([{ name: "avatars", id: "avatars" }]);
        }).pipe(Effect.scoped),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, dohFetch)),
            ),
            BunServices.layer,
          ),
        ),
      ),
  );
});
