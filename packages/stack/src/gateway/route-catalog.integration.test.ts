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
      const catalog = routeCatalogFor(compiled.executionPlan);
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
      expect((catalog.http.get("studio") ?? [])[0]?.match({ path: "/", headers: {} })).toBe(true);
      expect((catalog.http.get("mailUi") ?? [])[0]?.binding).toBe("ui");
      expect((catalog.tcp.get("database") ?? [])[0]?.capability).toBe("database");
      expect((catalog.tcp.get("pooler") ?? [])[0]?.capability).toBe("pooler");
      expect((catalog.tcp.get("smtp") ?? [])[0]?.binding).toBe("smtp");
      expect((catalog.tcp.get("pop3") ?? [])[0]?.binding).toBe("pop3");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
