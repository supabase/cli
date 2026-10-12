import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as net from "node:net";

import { DnsResolverFlag } from "./global-flags.ts";
import { DbConnectError } from "./db-connection.errors.ts";
import { buildDohRequest, dohFetch, dohFetchLayer } from "./http-dns.ts";

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
    expect(result.hostHeader).toBe("api.supabase.com:8443");
  });

  it("does not include the port in the Host header for the default HTTPS port", () => {
    const result = buildDohRequest("https://api.supabase.com:443/v1/projects", "203.0.113.10");
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
    expect(net.isIP(result.serverName)).toBe(0);
    expect(result.serverName).toBe("api.supabase.com");
  });
});

describe("dohFetch", () => {
  type CapturedCall = {
    url: string;
    init: RequestInit & { tls?: { serverName: string } };
  };

  function makeFakeFetch(captured: CapturedCall[]): typeof globalThis.fetch {
    const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.push({ url, init: (init ?? {}) as CapturedCall["init"] });
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    return fn as typeof globalThis.fetch;
  }

  function makeFakeResolver(ips: string[]) {
    return (_host: string) => Effect.succeed(ips);
  }

  it.effect("dials the first resolved IP, sets tls.serverName, and injects Host header", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: makeFakeResolver(["203.0.113.10", "203.0.113.11"]),
        innerFetch: makeFakeFetch(captured),
      });

      yield* Effect.promise(() =>
        fetchFn("https://api.supabase.com/v1/projects", {
          method: "GET",
          headers: { authorization: "Bearer tok" },
        }),
      );

      expect(captured).toHaveLength(1);
      const call = captured[0]!;
      expect(new URL(call.url).hostname).toBe("203.0.113.10");
      expect(new URL(call.url).pathname).toBe("/v1/projects");
      expect(call.init.tls?.serverName).toBe("api.supabase.com");
      // Host header pinned to original hostname.
      const headers = new Headers(call.init.headers);
      expect(headers.get("host")).toBe("api.supabase.com");
      // Other headers preserved.
      expect(headers.get("authorization")).toBe("Bearer tok");
    }),
  );

  it.effect("preserves entries from a WHATWG Headers instance (supabase-js shape)", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: makeFakeResolver(["203.0.113.10"]),
        innerFetch: makeFakeFetch(captured),
      });

      // supabase-js passes `init.headers` as a `Headers` instance, not a plain
      // record. Spreading a `Headers` instance yields zero entries, so this is
      // the regression case: auth and capability headers must survive the
      // DoH rewrite.
      yield* Effect.promise(() =>
        fetchFn("https://feedback.supabase.co/rest/v1/interfaces_feedback", {
          method: "DELETE",
          headers: new Headers({
            apikey: "sb_publishable_key",
            "content-type": "application/json",
            "x-feedback-token": "123e4567-e89b-12d3-a456-426614174000",
          }),
        }),
      );

      const headers = new Headers(captured[0]!.init.headers);
      expect(headers.get("apikey")).toBe("sb_publishable_key");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-feedback-token")).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(headers.get("host")).toBe("feedback.supabase.co");
    }),
  );

  it.effect("preserves headers embedded on a Request when no init headers are given", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: makeFakeResolver(["203.0.113.10"]),
        innerFetch: makeFakeFetch(captured),
      });

      yield* Effect.promise(() =>
        fetchFn(
          new Request("https://api.supabase.com/v1/projects", {
            headers: { authorization: "Bearer tok" },
          }),
        ),
      );

      const headers = new Headers(captured[0]!.init.headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      expect(headers.get("host")).toBe("api.supabase.com");
    }),
  );

  it.effect("cancels an in-flight DoH resolution when the request signal aborts", () => {
    // Ctrl-C or a caller timeout during the DNS lookup must not leave the
    // resolver running (holding the process open) until the DoH server
    // answers: the request signal has to reach the resolver fiber.
    const controller = new AbortController();

    return Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: () => Effect.never,
        innerFetch: makeFakeFetch(captured),
      });

      const pending = fetchFn("https://api.supabase.com/v1/projects", {
        signal: controller.signal,
      });
      controller.abort();

      expect(Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => pending)))).toBe(true);
      expect(captured).toHaveLength(0);
    });
  });

  it.effect("cancels the DoH lookup when the request signal is already aborted", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      let cancelled = 0;
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: () =>
          Effect.yieldNow.pipe(
            Effect.as(["203.0.113.10"]),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled += 1;
              }),
            ),
          ),
        innerFetch: makeFakeFetch(captured),
      });

      const pending = fetchFn("https://api.supabase.com/v1/projects", {
        signal: AbortSignal.abort(),
      });

      expect(Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => pending)))).toBe(true);
      expect(captured).toHaveLength(0);
      expect(cancelled).toBe(1);
    }),
  );

  it.effect("keeps fetch's own rejection when the request signal is aborted", () =>
    Effect.gen(function* () {
      const abortError = new DOMException("The operation was aborted.", "AbortError");

      for (const dnsResolver of ["native", "https"] as const) {
        const fetchFn = dohFetch({
          dnsResolver,
          resolver: makeFakeResolver(["203.0.113.10"]),
          innerFetch: () => Promise.reject(abortError),
        });

        const error = yield* Effect.flip(
          Effect.tryPromise(() =>
            fetchFn("https://api.supabase.com/v1/projects", { signal: AbortSignal.abort() }),
          ),
        );
        expect(error.cause).toBe(abortError);
      }
    }),
  );

  it.effect("keeps a response that completes as the request signal aborts", () => {
    const controllers = {
      native: new AbortController(),
      https: new AbortController(),
    };

    return Effect.gen(function* () {
      for (const dnsResolver of ["native", "https"] as const) {
        const controller = controllers[dnsResolver];
        const fetchFn = dohFetch({
          dnsResolver,
          resolver: makeFakeResolver(["203.0.113.10"]),
          innerFetch: () => {
            controller.abort();
            return Promise.resolve(new Response("ok", { status: 200 }));
          },
        });

        const response = yield* Effect.promise(() =>
          fetchFn("https://api.supabase.com/v1/projects", { signal: controller.signal }),
        );
        expect(response.status).toBe(200);
      }
    });
  });

  it.effect("passes through without DoH when dnsResolver is 'native'", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const resolverCalls: string[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "native",
        resolver: (host) => {
          resolverCalls.push(host);
          return Effect.succeed(["203.0.113.10"]);
        },
        innerFetch: makeFakeFetch(captured),
      });

      yield* Effect.promise(() => fetchFn("https://api.supabase.com/v1/projects"));

      expect(captured[0]?.url).toBe("https://api.supabase.com/v1/projects");
      expect(resolverCalls).toHaveLength(0);
    }),
  );

  it.effect("passes through without DoH when the URL host is already an IPv4 literal", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const resolverCalls: string[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: (host) => {
          resolverCalls.push(host);
          return Effect.succeed(["203.0.113.10"]);
        },
        innerFetch: makeFakeFetch(captured),
      });

      yield* Effect.promise(() => fetchFn("https://203.0.113.99/v1/projects"));

      expect(captured[0]?.url).toBe("https://203.0.113.99/v1/projects");
      expect(resolverCalls).toHaveLength(0);
    }),
  );

  it.effect("passes through without DoH when the URL host is already an IPv6 literal", () =>
    Effect.gen(function* () {
      const captured: CapturedCall[] = [];
      const resolverCalls: string[] = [];
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: (host) => {
          resolverCalls.push(host);
          return Effect.succeed(["2001:db8::1"]);
        },
        innerFetch: makeFakeFetch(captured),
      });

      yield* Effect.promise(() => fetchFn("https://[2001:db8::1]/v1/projects"));

      expect(captured[0]?.url).toBe("https://[2001:db8::1]/v1/projects");
      expect(resolverCalls).toHaveLength(0);
    }),
  );

  it.effect("propagates resolver failures as rejected promises", () =>
    Effect.gen(function* () {
      const fetchFn = dohFetch({
        dnsResolver: "https",
        resolver: (_host) => Effect.fail(new DbConnectError({ message: "DoH timed out" })),
        innerFetch: makeFakeFetch([]),
      });

      const error = yield* Effect.flip(
        Effect.tryPromise(() => fetchFn("https://api.supabase.com/v1/projects")),
      );
      expect(error.cause).toBeInstanceOf(DbConnectError);
    }),
  );
});

describe("dohFetchLayer (Effect layer integration)", () => {
  it.effect("installs a DoH-aware fetch when dns-resolver is 'https'", () => {
    const captured: Array<{ url: string; tls?: { serverName: string } }> = [];

    const fakeFetch = dohFetch({
      dnsResolver: "https",
      resolver: (_host) => Effect.succeed(["203.0.113.10"]),
      innerFetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        captured.push({ url, tls: (init as { tls?: { serverName: string } })?.tls });
        return Promise.resolve(new Response("ok", { status: 200 }));
      }) as typeof globalThis.fetch,
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => fakeFetch("https://api.supabase.com/v1/projects"));

      expect(captured).toHaveLength(1);
      expect(new URL(captured[0]!.url).hostname).toBe("203.0.113.10");
      expect(captured[0]!.tls?.serverName).toBe("api.supabase.com");
    });
  });

  it.effect("dohFetchLayer provides FetchHttpClient.Fetch from context via DnsResolverFlag", () => {
    const { FetchHttpClient } = require("effect/http") as {
      FetchHttpClient: typeof import("effect/http").FetchHttpClient;
    };

    return Effect.gen(function* () {
      const dohLayer = dohFetchLayer.pipe(Layer.provide(Layer.succeed(DnsResolverFlag, "https")));
      const fetchFn = yield* FetchHttpClient.Fetch.pipe(Effect.provide(dohLayer));
      expect(typeof fetchFn).toBe("function");
    });
  });

  it.effect("dohFetchLayer with 'native' also provides a fetch function", () => {
    const { FetchHttpClient } = require("effect/http") as {
      FetchHttpClient: typeof import("effect/http").FetchHttpClient;
    };

    return Effect.gen(function* () {
      const nativeLayer = dohFetchLayer.pipe(
        Layer.provide(Layer.succeed(DnsResolverFlag, "native")),
      );
      const fetchFn = yield* FetchHttpClient.Fetch.pipe(Effect.provide(nativeLayer));
      expect(typeof fetchFn).toBe("function");
    });
  });
});
