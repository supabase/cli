import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CommandSettings } from "../config/command-settings.service.ts";
import { LoginApi, type LoginApiSessionResponse } from "../commands/login/login-api.service.ts";
import { LoginVerificationError } from "../commands/login/login.errors.ts";
import { block } from "./command-permissions/model.ts";

/** The profile lookup that stitches the account identity after login. */
export const loginProfile = block("login-profile", [
  { operationId: "v1-get-profile", kind: "best-effort" },
]);

const POLL_TIMEOUT = "10 seconds";

// HttpClientError reasons meaning the response arrived but its body couldn't be decoded
// (including a 2xx with invalid JSON) — classified as `decode`, not a transport `network` failure.
const BODY_DECODE_REASONS = new Set<string>(["DecodeError", "EmptyBodyError"]);

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

export const loginApiLayer = Layer.effect(
  LoginApi,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliSettings = yield* CommandSettings;

    return LoginApi.of({
      fetchLoginSession: (apiHost: string, sessionId: string, deviceCode: string) =>
        Effect.gen(function* () {
          // Not in the Management API OpenAPI spec, so it stays a raw request.
          const url = `${apiHost}/platform/cli/login/${encodeURIComponent(sessionId)}?device_code=${encodeURIComponent(deviceCode)}`;
          const request = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
          );
          const response = yield* httpClient.execute(request);
          if (response.status !== 200) {
            const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* new LoginVerificationError({
              message: `Error status ${response.status}: ${body}`,
              statusCode: response.status,
            });
          }
          const body = yield* response.json;
          const session: LoginApiSessionResponse = {
            access_token: readString(body, "access_token"),
            public_key: readString(body, "public_key"),
            nonce: readString(body, "nonce"),
          };
          return session;
        }).pipe(
          // The explicit non-200 `LoginVerificationError` above passes through untouched here,
          // since it isn't an `HttpClientError`.
          Effect.catchTag("HttpClientError", (cause) =>
            Effect.fail(
              BODY_DECODE_REASONS.has(cause.reason._tag)
                ? new LoginVerificationError({
                    message: `failed to execute http request: ${cause.message}`,
                    decode: true,
                  })
                : new LoginVerificationError({
                    message: `failed to execute http request: ${cause.message}`,
                    network: true,
                  }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: POLL_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new LoginVerificationError({
                  message: "failed to execute http request: request timed out",
                  network: true,
                }),
              ),
          }),
        ),

      // No client is configured yet at login (the token was just obtained), so build one for this
      // host and token.
      fetchGotrueId: (apiHost: string, token: string) =>
        Effect.gen(function* () {
          const api = yield* makeApiClient({
            baseUrl: apiHost,
            accessToken: token,
            userAgent: cliSettings.userAgent,
          });
          const profile = yield* api.v1.getProfile();
          return profile.gotrue_id.length > 0
            ? Option.some(profile.gotrue_id)
            : Option.none<string>();
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  }),
);
