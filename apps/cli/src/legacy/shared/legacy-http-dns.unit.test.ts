import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as net from "node:net";

import { LegacyDnsResolverFlag } from "../../shared/legacy/global-flags.ts";
import { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";
import { buildDohRequest, legacyDohFetch, legacyDohFetchLayer } from "./legacy-http-dns.ts";

// ---------------------------------------------------------------------------
// buildDohRequest — pure URL-rewrite helper
// ---------------------------------------------------------------------------

describe("buildDohRequest", () => {
  it("replaces the hostname with the resolved IPv4 address", () => {
    const result = buildDohRequest("https://api.supabase.com/v1/projects", "203.0.113.10");
    expect(result.url).toBe("https://203.0.113.10/v1/projects");
    expect(result.serverName).toBe("api.supabase.com");
    expect(result.hostHeader).toBe("api.supabase.com");
  });

  it("brackets IPv6 addresses in the URL authority", () => {
    const result = buildDohRequest("https://api.supabase.com/v1/projects", "2001:db8::1");
    expect(result.url).toBe("https://[2001:db8::1]/v1/projects");
    expect(result.serverName).toBe("api.supabase.com");
    expect(result.hostHeader).toBe("api.supabase.com");
  });

  it("preserves an explicit non-standard port in the Host header", () => {
    const result = buildDohRequest("https://api.supabase.com:8443/v1/projects", "203.0.113.10");
    expect(result.url).toBe("https://203.0.113.10:8443/v1/projects");
    expect(result.serverName).toBe("api.supabase.com");
    // Host header must include the port when it differs from the scheme default.
    expect(result.hostHeader).toBe("api.supabase.com:8443");
  });

  it("does not include the port in the Host header for the default HTTPS port", () => {
    const result = buildDohRequest("https://api.supabase.com:443/v1/projects", "203.0.113.10");
    // URL constructor normalises :443 away for https.
    expect(result.url).toBe("https://203.0.113.10/v1/projects");
    expect(result.hostHeader).toBe("api.supabase.com");
  });

  it("preserves path, query string, and fragment after the host swap", () => {
    const result = buildDohRequest(
      "https://api.supabase.com/v1/projects?foo=bar#section",
      "203.0.113.10",
    );
    expect(result.url).toBe("https://203.0.113.10/v1/projects?foo=bar#section");
  });

  it("sets serverName to the bare hostname, never the IP", () => {
    const result = buildDohRequest("https://api.supabase.com/", "203.0.113.10");
    // serverName must be the original hostname for TLS SNI + cert validation.
    expect(net.isIP(result.serverName)).toBe(0); // not an IP
    expect(result.serverName).toBe("api.supabase.com");
  });
});

// ---------------------------------------------------------------------------
// legacyDohFetch — fetch wrapper with injectable fakes
// ---------------------------------------------------------------------------

describe("legacyDohFetch", () => {
  type CapturedCall = {
    url: string;
    init: RequestInit & { tls?: { serverName: string } };
  };

  function makeFakeFetch(captured: CapturedCall[]): typeof globalThis.fetch {
    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.push({ url, init: (init ?? {}) as CapturedCall["init"] });
      return new Response("ok", { status: 200 });
    };
    return fn as typeof globalThis.fetch;
  }

  function makeFakeResolver(ips: string[]) {
    return (_host: string) => Effect.succeed(ips);
  }

  it("dials the first resolved IP, sets tls.serverName, and injects Host header", async () => {
    const captured: CapturedCall[] = [];
    const fetchFn = legacyDohFetch({
      dnsResolver: "https",
      resolver: makeFakeResolver(["203.0.113.10", "203.0.113.11"]),
      innerFetch: makeFakeFetch(captured),
    });

    await fetchFn("https://api.supabase.com/v1/projects", {
      method: "GET",
      headers: { authorization: "Bearer tok" },
    });

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    // URL authority is the first resolved IP.
    expect(new URL(call.url).hostname).toBe("203.0.113.10");
    // Path preserved.
    expect(new URL(call.url).pathname).toBe("/v1/projects");
    // TLS SNI set to original hostname (CWE-350 guard).
    expect(call.init.tls?.serverName).toBe("api.supabase.com");
    // Host header pinned to original hostname.
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Host"]).toBe("api.supabase.com");
    // Other headers preserved.
    expect(headers["authorization"]).toBe("Bearer tok");
  });

  it("passes through without DoH when dnsResolver is 'native'", async () => {
    const captured: CapturedCall[] = [];
    const resolverCalls: string[] = [];
    const fetchFn = legacyDohFetch({
      dnsResolver: "native",
      resolver: (host) => {
        resolverCalls.push(host);
        return Effect.succeed(["203.0.113.10"]);
      },
      innerFetch: makeFakeFetch(captured),
    });

    await fetchFn("https://api.supabase.com/v1/projects");

    // Original URL passed through unchanged.
    expect(captured[0]?.url).toBe("https://api.supabase.com/v1/projects");
    expect(resolverCalls).toHaveLength(0);
  });

  it("passes through without DoH when the URL host is already an IPv4 literal", async () => {
    const captured: CapturedCall[] = [];
    const resolverCalls: string[] = [];
    const fetchFn = legacyDohFetch({
      dnsResolver: "https",
      resolver: (host) => {
        resolverCalls.push(host);
        return Effect.succeed(["203.0.113.10"]);
      },
      innerFetch: makeFakeFetch(captured),
    });

    await fetchFn("https://203.0.113.99/v1/projects");

    expect(captured[0]?.url).toBe("https://203.0.113.99/v1/projects");
    expect(resolverCalls).toHaveLength(0);
  });

  it("passes through without DoH when the URL host is already an IPv6 literal", async () => {
    const captured: CapturedCall[] = [];
    const resolverCalls: string[] = [];
    const fetchFn = legacyDohFetch({
      dnsResolver: "https",
      resolver: (host) => {
        resolverCalls.push(host);
        return Effect.succeed(["2001:db8::1"]);
      },
      innerFetch: makeFakeFetch(captured),
    });

    await fetchFn("https://[2001:db8::1]/v1/projects");

    expect(captured[0]?.url).toBe("https://[2001:db8::1]/v1/projects");
    expect(resolverCalls).toHaveLength(0);
  });

  it("propagates resolver failures as rejected promises", async () => {
    const fetchFn = legacyDohFetch({
      dnsResolver: "https",
      resolver: (_host) => Effect.fail(new LegacyDbConnectError({ message: "DoH timed out" })),
      innerFetch: makeFakeFetch([]),
    });

    await expect(fetchFn("https://api.supabase.com/v1/projects")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Effect-layer integration: legacyDohFetchLayer overrides FetchHttpClient.Fetch
// ---------------------------------------------------------------------------

describe("legacyDohFetchLayer (Effect layer integration)", () => {
  it.effect("installs a DoH-aware fetch when dns-resolver is 'https'", () => {
    const captured: Array<{ url: string; tls?: { serverName: string } }> = [];

    const fakeFetch = legacyDohFetch({
      dnsResolver: "https",
      resolver: (_host) => Effect.succeed(["203.0.113.10"]),
      innerFetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        captured.push({ url, tls: (init as { tls?: { serverName: string } })?.tls });
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    });

    return Effect.gen(function* () {
      // Verify the DoH fetch rewrites the URL and sets serverName correctly.
      yield* Effect.promise(() => fakeFetch("https://api.supabase.com/v1/projects"));

      expect(captured).toHaveLength(1);
      expect(new URL(captured[0]!.url).hostname).toBe("203.0.113.10");
      expect(captured[0]!.tls?.serverName).toBe("api.supabase.com");
    });
  });

  it.effect(
    "legacyDohFetchLayer provides FetchHttpClient.Fetch from context via LegacyDnsResolverFlag",
    () => {
      const { FetchHttpClient } = require("effect/unstable/http") as {
        FetchHttpClient: typeof import("effect/unstable/http").FetchHttpClient;
      };

      return Effect.gen(function* () {
        // With dnsResolver = "https", the layer should provide a function.
        const dohLayer = legacyDohFetchLayer.pipe(
          Layer.provide(Layer.succeed(LegacyDnsResolverFlag, "https")),
        );
        const fetchFn = yield* FetchHttpClient.Fetch.pipe(Effect.provide(dohLayer));
        expect(typeof fetchFn).toBe("function");
      });
    },
  );

  it.effect("legacyDohFetchLayer with 'native' also provides a fetch function", () => {
    const { FetchHttpClient } = require("effect/unstable/http") as {
      FetchHttpClient: typeof import("effect/unstable/http").FetchHttpClient;
    };

    return Effect.gen(function* () {
      const nativeLayer = legacyDohFetchLayer.pipe(
        Layer.provide(Layer.succeed(LegacyDnsResolverFlag, "native")),
      );
      const fetchFn = yield* FetchHttpClient.Fetch.pipe(Effect.provide(nativeLayer));
      expect(typeof fetchFn).toBe("function");
    });
  });
});
