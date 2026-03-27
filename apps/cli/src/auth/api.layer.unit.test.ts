import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { Api } from "./api.service.ts";
import { ApiError } from "./errors.ts";
import { makeApi } from "./api.layer.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = "https://api.supabase.com";
const SESSION_ID = "test-session-id";
const DEVICE_CODE = "test-device-code";
const EXPECTED_URL = `${API_URL}/platform/cli/login/${SESSION_ID}?device_code=${DEVICE_CODE}`;

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function mockHttpClient(opts: { status?: number; body?: unknown; transportError?: string }) {
  const requests: string[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
      (requestEffect) =>
        Effect.flatMap(requestEffect, (request) => {
          requests.push(request.url);
          if (opts.transportError !== undefined) {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error(opts.transportError),
                  description: opts.transportError,
                }),
              }),
            );
          }
          const webResponse = new Response(JSON.stringify(opts.body ?? null), {
            status: opts.status ?? 200,
          });
          return Effect.succeed(HttpClientResponse.fromWeb(request, webResponse));
        }),
      Effect.succeed,
    ),
  );

  return {
    layer,
    get requests() {
      return requests;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFailError(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  const fail = exit.cause.reasons.find(Cause.isFailReason);
  if (!fail) throw new Error("Expected fail reason");
  return fail.error;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Api", () => {
  describe("fetchLoginSession", () => {
    it.effect("parses JSON on successful response", () => {
      const responseBody = {
        access_token: "sbp_token_123",
        public_key: "04abcdef",
        nonce: "deadbeef",
      };
      const { layer: httpLayer } = mockHttpClient({ body: responseBody });
      const testLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(httpLayer));
      return Effect.gen(function* () {
        const { fetchLoginSession } = yield* Api;
        const result = yield* fetchLoginSession(API_URL, SESSION_ID, DEVICE_CODE);
        expect(result).toEqual(responseBody);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("constructs correct URL", () => {
      const responseBody = { access_token: "", public_key: "", nonce: "" };
      const mock = mockHttpClient({ body: responseBody });
      const testLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const { fetchLoginSession } = yield* Api;
        yield* fetchLoginSession(API_URL, SESSION_ID, DEVICE_CODE);
        expect(mock.requests[0]).toBe(EXPECTED_URL);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("returns ApiError on non-OK response", () => {
      const { layer: httpLayer } = mockHttpClient({ status: 404, body: "Not Found" });
      const testLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(httpLayer));
      return Effect.gen(function* () {
        const { fetchLoginSession } = yield* Api;
        const exit = yield* fetchLoginSession(API_URL, SESSION_ID, DEVICE_CODE).pipe(Effect.exit);
        const error = getFailError(exit) as ApiError;
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(404);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("returns ApiError with message on network/transport error", () => {
      const { layer: httpLayer } = mockHttpClient({ transportError: "Network failure" });
      const testLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(httpLayer));
      return Effect.gen(function* () {
        const { fetchLoginSession } = yield* Api;
        const exit = yield* fetchLoginSession(API_URL, SESSION_ID, DEVICE_CODE).pipe(Effect.exit);
        const error = getFailError(exit) as ApiError;
        expect(error).toBeInstanceOf(ApiError);
        expect(error.detail).toContain("Network failure");
        expect(error.statusCode).toBeUndefined();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("ApiError detail includes status code on non-OK response", () => {
      const { layer: httpLayer } = mockHttpClient({ status: 503, body: "Service Unavailable" });
      const testLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(httpLayer));
      return Effect.gen(function* () {
        const { fetchLoginSession } = yield* Api;
        const exit = yield* fetchLoginSession(API_URL, SESSION_ID, DEVICE_CODE).pipe(Effect.exit);
        const error = getFailError(exit) as ApiError;
        expect(error.statusCode).toBe(503);
        expect(error.detail).toContain("503");
      }).pipe(Effect.provide(testLayer));
    });
  });
});
