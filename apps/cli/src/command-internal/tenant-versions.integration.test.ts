import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";

import { fetchGotrueVersion, probeTenantVersions } from "./tenant-versions.ts";

const tenant = {
  ref: "abcdefghijklmnopqrst",
  projectHost: "supabase.test",
  serviceKey: "service-role-key",
  userAgent: "test",
};

const hangingClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);

describe("probeTenantVersions", () => {
  it.effect("reports every service of a tenant that never answers as failed", () =>
    Effect.gen(function* () {
      const probe = yield* probeTenantVersions(tenant).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("10 seconds");

      const observed = yield* Fiber.join(probe);
      expect(observed.rest._tag).toBe("Failed");
      expect(observed.auth._tag).toBe("Failed");
      expect(observed.storage._tag).toBe("Failed");
    }).pipe(Effect.provide(hangingClient)),
  );
});

const serve = (fetch: (request: Request) => Response) =>
  Effect.acquireRelease(
    Effect.try(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  );

/** A tenant host that redirects every request to another origin, which records the `apikey` it receives. */
const redirectingTenant = Effect.gen(function* () {
  const leakedKeys: Array<string | null> = [];
  const elsewhere = yield* serve((request) => {
    leakedKeys.push(request.headers.get("apikey"));
    return Response.json({ version: "v2.0.0", info: { version: "v12.0.0" } });
  });
  const host = yield* serve(() => Response.redirect(`http://localhost:${elsewhere.port}/`, 302));
  const fetch = yield* FetchHttpClient.Fetch;
  const toTenantHost: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace(/^https:\/\/[^/]+/u, `http://127.0.0.1:${host.port}`), init),
    { preconnect: () => Promise.resolve() },
  );
  const withTenantHost = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, toTenantHost),
    );
  return { leakedKeys, withTenantHost };
});

describe("tenant version requests", () => {
  it.live("report a tenant redirect as a failed probe without sending the key onward", () =>
    Effect.gen(function* () {
      const { leakedKeys, withTenantHost } = yield* redirectingTenant;

      const observed = yield* withTenantHost(probeTenantVersions(tenant));

      expect(observed.auth).toEqual({ _tag: "Failed", cause: "HTTP 302" });
      expect(observed.rest).toEqual({ _tag: "Failed", cause: "HTTP 302" });
      expect(observed.storage).toEqual({ _tag: "Failed", cause: "HTTP 302" });
      expect(leakedKeys).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("never follow a tenant redirect when link reads a single service version", () =>
    Effect.gen(function* () {
      const { leakedKeys, withTenantHost } = yield* redirectingTenant;

      const version = yield* withTenantHost(fetchGotrueVersion(tenant));

      expect(version._tag).toBe("None");
      expect(leakedKeys).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
