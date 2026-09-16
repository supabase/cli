import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { compileStack } from "../model/Compiler.ts";
import { routeCatalogFor, type GatewayRouteCatalog } from "./RouteCatalog.ts";

const material = {
  publishableKey: "sb_publishable",
  secretKey: "sb_secret",
  anonJwt: "anon-jwt",
  serviceRoleJwt: "service-role-jwt",
} as const;

const catalogFixture = () =>
  Effect.gen(function* () {
    const compiled = yield* compileStack({
      projectRoot: "/tmp/route-catalog",
      runtime: { kind: "native" },
      config: { capabilities: { pooler: { enabled: true } } },
    });
    return routeCatalogFor(compiled.executionPlan, material);
  });

const routeFor = (
  catalog: GatewayRouteCatalog,
  path: string,
  headers: Readonly<Record<string, string>> = {},
) => {
  const route = (catalog.http.get("api") ?? []).find((candidate) =>
    candidate.match({ path, headers }),
  );
  if (route === undefined) throw new Error(`No API route matched ${path}`);
  return route;
};

const upstreamFor = (
  catalog: GatewayRouteCatalog,
  path: string,
  headers: Readonly<Record<string, string>> = {},
) => {
  const route = routeFor(catalog, path, headers);
  if (route.upstreamPath === undefined) throw new Error(`Route has no upstream path: ${path}`);
  return route.upstreamPath({ path, headers });
};

const headersFor = (
  catalog: GatewayRouteCatalog,
  path: string,
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string | string[]>> => {
  const route = routeFor(catalog, path, headers);
  if (route.upstreamHeaders === undefined)
    throw new Error(`Route has no header transform: ${path}`);
  return route.upstreamHeaders({ path, headers }, headers);
};

const headerCases = [
  {
    name: "publishable REST key",
    path: "/rest/v1/items",
    headers: { apikey: material.publishableKey },
    expected: { apikey: material.publishableKey, authorization: "Bearer anon-jwt" },
  },
  {
    name: "secret REST authorization",
    path: "/rest/v1/items",
    headers: { authorization: "Bearer sb_secret" },
    expected: { authorization: "Bearer service-role-jwt" },
  },
  {
    name: "user authorization",
    path: "/rest/v1/items",
    headers: { authorization: "Bearer user-jwt", apikey: material.secretKey },
    expected: { authorization: "Bearer user-jwt", apikey: material.secretKey },
  },
  {
    name: "unknown REST key",
    path: "/rest/v1/items",
    headers: { apikey: "legacy-unknown" },
    expected: { apikey: "legacy-unknown" },
  },
  {
    name: "publishable Auth key",
    path: "/auth/v1/token",
    headers: { apikey: material.publishableKey },
    expected: { apikey: material.publishableKey, authorization: "Bearer anon-jwt" },
  },
  {
    name: "secret Realtime API key",
    path: "/realtime/v1/api/tenants",
    headers: { apikey: material.secretKey },
    expected: { apikey: material.secretKey, authorization: "Bearer service-role-jwt" },
  },
  {
    name: "publishable Storage key",
    path: "/storage/v1/object/list",
    headers: { apikey: material.publishableKey },
    expected: { apikey: material.publishableKey, authorization: "Bearer anon-jwt" },
  },
  {
    name: "spoofed Functions key",
    path: "/functions/v1/hello",
    headers: { "sb-api-key": "spoofed", apikey: material.publishableKey },
    expected: { apikey: material.publishableKey, "sb-api-key": "Bearer anon-jwt" },
  },
  {
    name: "secret Functions key",
    path: "/functions/v1/hello",
    headers: { apikey: material.secretKey },
    expected: { apikey: material.secretKey, "sb-api-key": "Bearer service-role-jwt" },
  },
  {
    name: "unknown Functions key removes spoof",
    path: "/functions/v1/hello",
    headers: { "sb-api-key": "spoofed", apikey: "legacy-unknown" },
    expected: { apikey: "legacy-unknown" },
  },
  {
    name: "GraphQL profile",
    path: "/graphql/v1",
    headers: { authorization: "Bearer sb_publishable", "content-profile": "spoofed" },
    expected: { authorization: "Bearer anon-jwt", "content-profile": "graphql_public" },
  },
  {
    name: "S3 signature",
    path: "/storage/v1/s3/bucket/object",
    headers: { authorization: "AWS4-HMAC-SHA256 Credential=example" },
    expected: { authorization: "AWS4-HMAC-SHA256 Credential=example" },
  },
] as const;

describe("public gateway route catalog", () => {
  it.live("rewrites each enabled API prefix while preserving query strings", () =>
    catalogFixture().pipe(
      Effect.map((catalog) => {
        const expected = {
          "/rest/v1/items?limit=1": "/items?limit=1",
          "/graphql/v1?query=items": "/rpc/graphql?query=items",
          "/auth/v1/token?grant_type=password": "/token?grant_type=password",
          "/realtime/v1/websocket?vsn=1": "/socket/websocket?vsn=1",
          "/realtime/v1/api/tenants?limit=1": "/api/tenants?limit=1",
          "/storage/v1/s3/bucket/object?X-Amz-Signature=abc":
            "/s3/bucket/object?X-Amz-Signature=abc",
          "/storage/v1/object/list?limit=1": "/object/list?limit=1",
          "/functions/v1/hello?x=1": "/hello?x=1",
          "/analytics/v1/logs?limit=1": "/logs?limit=1",
        } as const;
        for (const [path, upstream] of Object.entries(expected))
          expect(upstreamFor(catalog, path)).toBe(upstream);
      }),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.live.each(headerCases)("transforms $name headers", ({ path, headers, expected }) =>
    catalogFixture().pipe(
      Effect.map((catalog) => expect(headersFor(catalog, path, headers)).toEqual(expected)),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.live("rewrites WebSocket host and API-key query credentials", () =>
    catalogFixture().pipe(
      Effect.map((catalog) => {
        const headers = headersFor(catalog, "/realtime/v1/websocket", {
          Host: "127.0.0.1:40000",
          apikey: material.publishableKey,
        });
        expect(headers).toMatchObject({ host: "realtime-dev", authorization: "Bearer anon-jwt" });
        expect(headers).not.toHaveProperty("Host");
        expect(upstreamFor(catalog, "/realtime/v1/websocket?apikey=sb_secret&vsn=1")).toBe(
          "/socket/websocket?apikey=service-role-jwt&vsn=1",
        );
      }),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.live("registers direct HTTP and TCP listeners for every enabled public service", () =>
    catalogFixture().pipe(
      Effect.map((catalog) => {
        const studioRoutes = catalog.http.get("studio");
        if (studioRoutes === undefined || studioRoutes.length !== 1)
          throw new Error("Expected one studio route");
        expect(studioRoutes[0]?.capability).toBe("studio");
        expect(studioRoutes[0]?.match({ path: "/", headers: {} })).toBe(true);
        expect(catalog.http.get("mailUi")).toEqual([
          expect.objectContaining({ capability: "mail", binding: "ui" }),
        ]);
        expect(catalog.http.get("functionsInspector")).toEqual([
          expect.objectContaining({ capability: "functions", binding: "inspector" }),
        ]);
        expect(catalog.tcp.get("database")).toEqual([
          expect.objectContaining({ capability: "database" }),
        ]);
        expect(catalog.tcp.get("pooler")).toEqual([
          expect.objectContaining({ capability: "pooler" }),
        ]);
        expect(catalog.tcp.get("smtp")).toEqual([expect.objectContaining({ binding: "smtp" })]);
        expect(catalog.tcp.get("pop3")).toEqual([expect.objectContaining({ binding: "pop3" })]);
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
});
