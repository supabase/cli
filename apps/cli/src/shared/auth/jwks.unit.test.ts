import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveRemoteJwks, toPublicJwk } from "./jwks.ts";

describe("toPublicJwk", () => {
  it("omits key_ops entirely for an RSA key whose ops filter down to none, matching Go's omitempty", () => {
    const result = toPublicJwk({ kty: "RSA", key_ops: ["sign"], n: "abc", e: "AQAB" });
    expect(result.key_ops).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("key_ops");
  });

  it("omits key_ops entirely for an EC key whose ops filter down to none, matching Go's omitempty", () => {
    const result = toPublicJwk({ kty: "EC", key_ops: ["sign"], crv: "P-256", x: "abc", y: "def" });
    expect(result.key_ops).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("key_ops");
  });

  it("keeps only the verify entry when key_ops mixes sign and verify", () => {
    const result = toPublicJwk({ kty: "RSA", key_ops: ["sign", "verify"], n: "abc", e: "AQAB" });
    expect(result.key_ops).toEqual(["verify"]);
  });

  it("leaves key_ops undefined when the input never set it", () => {
    const result = toPublicJwk({ kty: "RSA", n: "abc", e: "AQAB" });
    expect(result.key_ops).toBeUndefined();
  });
});

describe("resolveRemoteJwks", () => {
  it.effect("times out while decoding a stalled discovery response body", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          const response = HttpClientResponse.fromWeb(
            request,
            new Response("{}", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
          Object.defineProperty(response, "json", { value: Effect.never });
          return response;
        }),
      );
      const fiber = yield* resolveRemoteJwks("https://issuer.example.com").pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("12 seconds");

      const exit = fiber.pollUnsafe();
      expect(exit).toBeDefined();
      if (exit !== undefined) {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.squash(exit.cause);
          expect(failure).toBeInstanceOf(Error);
          if (failure instanceof Error) {
            expect(failure.constructor.name).toBe("RemoteJwksError");
          }
        }
      }
    }),
  );
});
