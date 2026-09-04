import { Effect, Layer } from "effect";
import { makeApiClient } from "@supabase/api/effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { ApiError } from "./errors.ts";
import { Api, type LoginSessionResponse } from "./api.service.ts";

// HttpClientError reasons that mean the response arrived but its body could not
// be decoded (including a 2xx whose body isn't valid JSON). These are API
// response problems, not transport ones, so they classify by `decode` rather
// than a status code.
const BODY_DECODE_REASONS = new Set<string>(["DecodeError", "EmptyBodyError"]);

/**
 * Maps any fetcher failure to an {@link ApiError}, preserving the classification
 * signal:
 * - a received status → `statusCode` (transport error → status-less, classified
 *   as network);
 * - a body/schema decode failure — whether an `HttpClientError` decode reason or
 *   a non-`HttpClientError` thrown while decoding — → `decode: true`, classified
 *   as an API response problem instead of network.
 */
function mapToApiError(error: unknown): Effect.Effect<never, ApiError> {
  if (HttpClientError.isHttpClientError(error)) {
    if (BODY_DECODE_REASONS.has(error.reason._tag)) {
      return Effect.fail(new ApiError({ detail: error.message, decode: true }));
    }
    if (error.response !== undefined) {
      return Effect.fail(
        new ApiError({
          statusCode: error.response.status,
          detail: `${error.response.status} ${error.message}`,
        }),
      );
    }
    return Effect.fail(new ApiError({ detail: error.message }));
  }
  return Effect.fail(
    new ApiError({
      detail: error instanceof Error ? error.message : String(error),
      decode: true,
    }),
  );
}

export const makeApi = Effect.gen(function* () {
  const rawHttpClient = yield* HttpClient.HttpClient;
  const httpClient = rawHttpClient.pipe(HttpClient.filterStatusOk);
  const httpClientLayer = Layer.succeed(HttpClient.HttpClient, rawHttpClient);

  return Api.of({
    fetchLoginSession: Effect.fnUntraced(
      function* (apiUrl: string, sessionId: string, deviceCode: string) {
        const url = `${apiUrl}/platform/cli/login/${sessionId}?device_code=${deviceCode}`;
        const response = yield* httpClient.execute(HttpClientRequest.get(url));
        return (yield* response.json) as LoginSessionResponse;
      },
      (effect) => effect.pipe(Effect.catch(mapToApiError)),
    ),
    fetchProfile: Effect.fnUntraced(
      function* (apiUrl, accessToken) {
        const api = yield* makeApiClient({
          baseUrl: apiUrl,
          accessToken,
          userAgent: "supabase",
        }).pipe(Effect.provide(httpClientLayer));
        return yield* api.v1.getProfile();
      },
      (effect) => effect.pipe(Effect.catch(mapToApiError)),
    ),
  });
});
