import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import { parseResolvedIps, resolveHostsOverHttps } from "./db-dns.ts";

describe("parseResolvedIps", () => {
  it("returns every A/AAAA address in order, skipping non-address records", () => {
    const payload = {
      Answer: [
        { name: "db.example.com", type: 5, data: "alias.example.com" },
        { name: "db.example.com", type: 1, data: "203.0.113.10" },
        { name: "db.example.com", type: 28, data: "2606:4700:4700::1111" },
      ],
    };
    expect(parseResolvedIps(payload, "db.example.com")).toEqual([
      "203.0.113.10",
      "2606:4700:4700::1111",
    ]);
  });

  it("accepts an AAAA record address", () => {
    const payload = { Answer: [{ type: 28, data: "2606:4700:4700::1111" }] };
    expect(parseResolvedIps(payload, "db.example.com")).toEqual(["2606:4700:4700::1111"]);
  });

  it("throws when the response has only non-address records", () => {
    const payload = { Answer: [{ type: 5, data: "alias.example.com" }] };
    expect(() => parseResolvedIps(payload, "db.example.com")).toThrow(
      "failed to locate valid IP for db.example.com",
    );
  });

  it("rejects an A-record whose data is not a valid IP (tampered DoH credential-redirect)", () => {
    // A non-IP payload like `1.2.3.4@attacker.com` must not be accepted: it would
    // otherwise become the URL authority in buildConnectionUrl.
    const payload = { Answer: [{ type: 1, data: "1.2.3.4@attacker.com" }] };
    expect(() => parseResolvedIps(payload, "db.example.com")).toThrow(
      "failed to locate valid IP for db.example.com",
    );
  });

  it("throws when there are no answers", () => {
    expect(() => parseResolvedIps({ Answer: [] }, "db.example.com")).toThrow(
      "failed to locate valid IP",
    );
  });

  it("throws when the payload is not a DNS-JSON object", () => {
    expect(() => parseResolvedIps(null, "db.example.com")).toThrow("failed to locate valid IP");
  });
});

describe("resolveHostsOverHttps", () => {
  const answering = (
    response: (init?: RequestInit) => Promise<Response>,
  ): typeof globalThis.fetch =>
    Object.assign((_input: string | URL | Request, init?: RequestInit) => response(init), {
      preconnect: () => Promise.resolve(),
    });
  const resolveWith = (fetch: typeof globalThis.fetch) =>
    resolveHostsOverHttps("db.example.com").pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  const prefix = "failed to resolve db.example.com via DNS-over-HTTPS: ";

  it.effect("returns the resolved addresses from a 200 DNS-JSON answer", () =>
    Effect.gen(function* () {
      const ips = yield* resolveWith(
        answering(() =>
          Promise.resolve(Response.json({ Answer: [{ type: 1, data: "203.0.113.10" }] })),
        ),
      );
      expect(ips).toEqual(["203.0.113.10"]);
    }),
  );

  it.effect("returns an IP literal unchanged without a lookup", () =>
    Effect.gen(function* () {
      expect(yield* resolveHostsOverHttps("203.0.113.10")).toEqual(["203.0.113.10"]);
    }),
  );

  it.effect.each([
    {
      name: "a non-200 status",
      response: () => Promise.resolve(new Response("", { status: 503 })),
      message: `${prefix}unexpected DNS query status 503`,
    },
    {
      name: "a rejected request",
      response: () => Promise.reject(new TypeError("network down")),
      message: `${prefix}network down`,
    },
    {
      name: "an answer without a valid IP",
      response: () => Promise.resolve(Response.json({})),
      message: `${prefix}failed to locate valid IP for db.example.com`,
    },
    {
      name: "an invalid JSON body",
      response: () => Promise.resolve(new Response("not json")),
      message: `${prefix}JSON Parse error: Unexpected identifier "not"`,
    },
    {
      name: "an empty body",
      response: () => Promise.resolve(new Response("")),
      message: `${prefix}Unexpected end of JSON input`,
    },
    {
      name: "a body of only a byte order mark",
      response: () => Promise.resolve(new Response(new Uint8Array([0xef, 0xbb, 0xbf]))),
      message: `${prefix}JSON Parse error: Unexpected EOF`,
    },
  ])("reports $name", ({ response, message }) =>
    Effect.gen(function* () {
      const error = yield* resolveWith(answering(response)).pipe(Effect.flip);
      expect(error.message).toBe(message);
    }),
  );

  it.effect("times out after 10 seconds", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const fiber = yield* resolveWith(
        answering((init) =>
          Effect.runPromiseWith(context)(Effect.never, { signal: init?.signal ?? undefined }),
        ),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe(`${prefix}timed out`);
    }),
  );
});
