import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { legacyBucketBody, legacyMakeStorageGateway } from "./legacy-storage-gateway.ts";

describe("legacyBucketBody", () => {
  it("omits public when undefined (Go *bool nil / omitempty)", () => {
    expect(legacyBucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual(
      {},
    );
  });

  it("includes public when explicitly set (true or false)", () => {
    expect(legacyBucketBody({ public: true, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: true,
    });
    expect(legacyBucketBody({ public: false, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: false,
    });
  });

  it("includes file_size_limit and allowed_mime_types only when non-empty", () => {
    expect(
      legacyBucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] }),
    ).not.toHaveProperty("file_size_limit");
    expect(
      legacyBucketBody({
        public: false,
        fileSizeLimit: 52_428_800,
        allowedMimeTypes: ["image/png"],
      }),
    ).toEqual({ public: false, file_size_limit: 52_428_800, allowed_mime_types: ["image/png"] });
  });
});

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

function setup(routes: ReadonlyArray<{ match: string; status?: number; body?: unknown }>) {
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
          new Response(JSON.stringify(route?.body ?? {}), {
            status: route?.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  return { requests, layer: Layer.mergeAll(httpLayer, BunServices.layer) };
}

describe("legacyMakeStorageGateway", () => {
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
      const gateway = yield* legacyMakeStorageGateway({
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
      const opaque = yield* legacyMakeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "sb_secret_local",
        userAgent: "ua",
      });
      yield* opaque.listBuckets();
      expect(requests[0]?.headers["apikey"]).toBe("sb_secret_local");
      expect(requests[0]?.headers["authorization"]).toBeUndefined();

      const jwt = yield* legacyMakeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "ey.jwt.key",
        userAgent: "ua",
      });
      yield* jwt.listBuckets();
      expect(requests[1]?.headers["authorization"]).toBe("Bearer ey.jwt.key");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a non-200 to a status error carrying the body", () => {
    const { layer } = setup([
      { match: "/storage/v1/object/move", status: 404, body: { error: "not_found" } },
    ]);
    return Effect.gen(function* () {
      const gateway = yield* legacyMakeStorageGateway({
        baseUrl: "http://127.0.0.1:54321",
        apiKey: "k",
        userAgent: "ua",
      });
      const exit = yield* gateway.moveObject("private", "a", "b").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("Error status 404");
      // The raw response body is carried on the status error for caller classification.
      expect(json).toContain("not_found");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the prefixes body for deleteObjects and decodes removed names", () => {
    const { requests, layer } = setup([
      { match: "/storage/v1/object/private", body: [{ name: "a.txt" }, { name: "b.txt" }] },
    ]);
    return Effect.gen(function* () {
      const gateway = yield* legacyMakeStorageGateway({
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
