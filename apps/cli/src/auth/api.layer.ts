import { Effect, Layer } from "effect";
import { supabaseApiClientLayer, v1GetProfile } from "@supabase/api/effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";

import { ApiError } from "./errors.ts";
import { Api, type LoginSessionResponse } from "./api.service.ts";

function mapHttpClientError(
  error: HttpClientError.HttpClientError,
): Effect.Effect<never, ApiError> {
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
      (effect) => effect.pipe(Effect.catch(mapHttpClientError)),
    ),
    fetchProfile: Effect.fnUntraced(
      function* (apiUrl, accessToken) {
        return yield* v1GetProfile().pipe(
          Effect.provide(
            supabaseApiClientLayer({
              baseUrl: apiUrl,
              accessToken,
              userAgent: "@supabase/cli",
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catch((error) => {
            if (HttpClientError.isHttpClientError(error)) {
              return mapHttpClientError(error);
            }
            return Effect.fail(
              new ApiError({
                detail: error instanceof Error ? error.message : String(error),
              }),
            );
          }),
        ),
    ),
  });
});

export const apiLayer = Layer.effect(Api, makeApi).pipe(Layer.provide(FetchHttpClient.layer));
