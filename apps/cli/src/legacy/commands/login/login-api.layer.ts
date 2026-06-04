import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyLoginApi, type LegacyLoginSessionResponse } from "./login-api.service.ts";
import { LegacyLoginVerificationError } from "./login.errors.ts";

const POLL_TIMEOUT = "10 seconds";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

export const legacyLoginApiLayer = Layer.effect(
  LegacyLoginApi,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliConfig = yield* LegacyCliConfig;

    return LegacyLoginApi.of({
      fetchLoginSession: (apiHost: string, sessionId: string, deviceCode: string) =>
        Effect.gen(function* () {
          const url = `${apiHost}/platform/cli/login/${sessionId}?device_code=${deviceCode}`;
          const request = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
          );
          const response = yield* httpClient.execute(request);
          if (response.status !== 200) {
            const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* Effect.fail(
              new LegacyLoginVerificationError({
                message: `Error status ${response.status}: ${body}`,
              }),
            );
          }
          const body = yield* response.json;
          const session: LegacyLoginSessionResponse = {
            access_token: readString(body, "access_token"),
            public_key: readString(body, "public_key"),
            nonce: readString(body, "nonce"),
          };
          return session;
        }).pipe(
          // Map transport / JSON-decode failures to the retry-driving error.
          // The explicit non-200 `LegacyLoginVerificationError` above passes
          // through untouched (it is not an `HttpClientError`).
          Effect.catchTag("HttpClientError", (cause) =>
            Effect.fail(
              new LegacyLoginVerificationError({
                message: `failed to execute http request: ${cause.message}`,
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: POLL_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new LegacyLoginVerificationError({
                  message: "failed to execute http request: request timed out",
                }),
              ),
          }),
        ),

      fetchGotrueId: (apiHost: string, token: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get(`${apiHost}/v1/profile`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
            HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
          );
          const response = yield* httpClient.execute(request);
          if (response.status !== 200) return Option.none<string>();
          const body = yield* response.json;
          const gotrueId = readString(body, "gotrue_id");
          return gotrueId.length > 0 ? Option.some(gotrueId) : Option.none<string>();
        }).pipe(Effect.orElseSucceed(() => Option.none<string>())),
    });
  }),
);
