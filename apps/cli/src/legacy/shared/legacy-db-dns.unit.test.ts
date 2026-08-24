import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as TestClock from "effect/testing/TestClock";

import { legacyResolveHostsOverHttps, parseResolvedIps } from "./legacy-db-dns.ts";

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
    // otherwise become the URL authority in legacyBuildConnectionUrl.
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

describe("legacyResolveHostsOverHttps", () => {
  it.effect("aborts the DNS-over-HTTPS body read when its deadline expires", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const fetchFn = Object.assign(
        (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          requestSignal = init?.signal ?? undefined;
          const response = new Response("{}", { status: 200 });
          Object.defineProperty(response, "json", {
            value: () => Promise.race([]),
          });
          return Promise.resolve(response);
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      const fiber = yield* legacyResolveHostsOverHttps("db.example.com").pipe(
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("11 seconds");

      expect(fiber.pollUnsafe()).toBeDefined();
      expect(requestSignal).toBeDefined();
      expect(requestSignal?.aborted).toBe(true);
    }),
  );
});
