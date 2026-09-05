import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { compileStack } from "../model/Compiler.ts";
import { routeCatalogFor } from "./RouteCatalog.ts";

describe("public gateway route catalog", () => {
  it.live("maps each enabled public listener to its exact service prefixes and bindings", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/route-catalog",
        runtime: { kind: "native" },
        config: { capabilities: { pooler: { enabled: true } } },
      }).pipe(Effect.provide(NodeServices.layer));
      const catalog = routeCatalogFor(compiled.executionPlan, {
        publishableKey: "sb_publishable",
        secretKey: "sb_secret",
        anonJwt: "anon-jwt",
        serviceRoleJwt: "service-role-jwt",
      });
      const api = catalog.http.get("api") ?? [];
      const find = (path: string, headers: Readonly<Record<string, string>> = {}) =>
        api.find((route) => route.match({ path, headers }));
      const upstream = (path: string, headers: Readonly<Record<string, string>> = {}) => {
        const route = find(path, headers);
        expect(route).toBeDefined();
        expect(route?.upstreamPath).toBeDefined();
        return route?.upstreamPath?.({ path, headers });
      };
      expect(upstream("/rest/v1/items?limit=1")).toBe("/items?limit=1");
      expect(upstream("/graphql/v1?query=items")).toBe("/rpc/graphql?query=items");
      expect(upstream("/auth/v1/token?grant_type=password")).toBe("/token?grant_type=password");
      expect(upstream("/realtime/v1/websocket?vsn=1")).toBe("/socket/websocket?vsn=1");
      expect(upstream("/realtime/v1/api/tenants?limit=1")).toBe("/api/tenants?limit=1");
      expect(upstream("/storage/v1/s3/bucket/object?X-Amz-Signature=abc")).toBe(
        "/s3/bucket/object?X-Amz-Signature=abc",
      );
      expect(upstream("/storage/v1/object/list?limit=1")).toBe("/object/list?limit=1");
      expect(upstream("/functions/v1/hello?x=1")).toBe("/hello?x=1");
      expect(upstream("/analytics/v1/logs?limit=1")).toBe("/logs?limit=1");

      const headersFor = (
        path: string,
        headers: Readonly<Record<string, string>>,
      ): Readonly<Record<string, string | string[]>> => {
        const route = find(path, headers);
        expect(route).toBeDefined();
        const transformed = route?.upstreamHeaders?.({ path, headers }, headers);
        expect(transformed).toBeDefined();
        return transformed ?? {};
      };
      expect(headersFor("/rest/v1/items", { apikey: "sb_publishable" })).toMatchObject({
        apikey: "sb_publishable",
        authorization: "Bearer anon-jwt",
      });
      expect(headersFor("/rest/v1/items", { authorization: "Bearer sb_secret" })).toMatchObject({
        authorization: "Bearer service-role-jwt",
      });
      expect(
        headersFor("/rest/v1/items", {
          authorization: "Bearer user-jwt",
          apikey: "sb_secret",
        }).authorization,
      ).toBe("Bearer user-jwt");
      expect(headersFor("/rest/v1/items", { apikey: "legacy-unknown" })).toEqual({
        apikey: "legacy-unknown",
      });
      expect(headersFor("/auth/v1/token", { apikey: "sb_publishable" }).authorization).toBe(
        "Bearer anon-jwt",
      );
      expect(headersFor("/realtime/v1/api/tenants", { apikey: "sb_secret" }).authorization).toBe(
        "Bearer service-role-jwt",
      );
      const realtimeWebsocketHeaders = headersFor("/realtime/v1/websocket", {
        Host: "127.0.0.1:40000",
        apikey: "sb_publishable",
      });
      expect(realtimeWebsocketHeaders).toMatchObject({
        host: "realtime-dev",
        authorization: "Bearer anon-jwt",
      });
      expect(realtimeWebsocketHeaders).not.toHaveProperty("Host");
      expect(
        headersFor("/storage/v1/object/list", { apikey: "sb_publishable" }).authorization,
      ).toBe("Bearer anon-jwt");
      expect(
        headersFor("/functions/v1/hello", {
          "sb-api-key": "spoofed",
          apikey: "sb_publishable",
        }),
      ).toMatchObject({ apikey: "sb_publishable", "sb-api-key": "Bearer anon-jwt" });
      expect(headersFor("/functions/v1/hello", { apikey: "sb_secret" })["sb-api-key"]).toBe(
        "Bearer service-role-jwt",
      );
      expect(
        headersFor("/functions/v1/hello", {
          "sb-api-key": "spoofed",
          apikey: "legacy-unknown",
        }),
      ).toEqual({ apikey: "legacy-unknown" });
      expect(
        headersFor("/graphql/v1", {
          authorization: "Bearer sb_publishable",
          "content-profile": "spoofed",
        }),
      ).toMatchObject({
        authorization: "Bearer anon-jwt",
        "content-profile": "graphql_public",
      });
      expect(
        headersFor("/storage/v1/s3/bucket/object", {
          authorization: "AWS4-HMAC-SHA256 Credential=example",
        }).authorization,
      ).toBe("AWS4-HMAC-SHA256 Credential=example");
      expect(upstream("/realtime/v1/websocket?apikey=sb_secret&vsn=1")).toBe(
        "/socket/websocket?apikey=service-role-jwt&vsn=1",
      );
      expect((catalog.http.get("studio") ?? [])[0]?.match({ path: "/", headers: {} })).toBe(true);
      expect((catalog.http.get("mailUi") ?? [])[0]?.binding).toBe("ui");
      expect((catalog.tcp.get("database") ?? [])[0]?.capability).toBe("database");
      expect((catalog.tcp.get("pooler") ?? [])[0]?.capability).toBe("pooler");
      expect((catalog.tcp.get("smtp") ?? [])[0]?.binding).toBe("smtp");
      expect((catalog.tcp.get("pop3") ?? [])[0]?.binding).toBe("pop3");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
