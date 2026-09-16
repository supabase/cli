import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveRemoteJwks } from "./jwks.ts";

const issuer = "https://issuer.example";

describe("remote signing keys", () => {
  it.live("discovers the key URL and preserves the provider's key payload", () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const keys = [{ kty: "RSA", kid: "key-1", custom: true }];
      const client = HttpClient.make((request) => {
        requested.push(request.url);
        const body = request.url.endsWith("openid-configuration")
          ? { jwks_uri: `${issuer}/keys` }
          : { keys };
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      });
      expect(
        yield* resolveRemoteJwks(issuer).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      ).toEqual(keys);
      expect(requested).toEqual([`${issuer}/.well-known/openid-configuration`, `${issuer}/keys`]);
    }),
  );

  for (const response of [
    { name: "unsuccessful discovery", status: 503, body: {} },
    { name: "missing discovery key URL", status: 200, body: {} },
    { name: "empty key document", status: 200, body: { keys: [] } },
  ]) {
    it.live(`rejects ${response.name}`, () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              response.name === "empty key document" && request.url.endsWith("openid-configuration")
                ? Response.json({ jwks_uri: `${issuer}/keys` })
                : Response.json(response.body, { status: response.status }),
            ),
          ),
        );
        const error = yield* resolveRemoteJwks(issuer).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip,
        );
        expect(error.reason).toBe("response");
      }),
    );
  }

  it.effect("bounds a stalled response body and aborts its request", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const client = HttpClient.make((request, _url, signal) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, signal);
          return HttpClientResponse.fromWeb(request, new Response(new ReadableStream()));
        }),
      );
      const fiber = yield* resolveRemoteJwks(issuer).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      const signal = yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(fiber)).reason).toBe("timeout");
      expect(signal.aborted).toBe(true);
    }),
  );

  it.live("caller interruption aborts the owned request without becoming a remote error", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const client = HttpClient.make((_request, _url, signal) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, signal);
          return yield* Effect.never;
        }),
      );
      const fiber = yield* resolveRemoteJwks(issuer).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild,
      );
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal.aborted).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }),
  );
});
