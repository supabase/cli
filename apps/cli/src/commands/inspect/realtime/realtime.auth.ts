import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { redactRealtimeText } from "./realtime.events.ts";
import { RealtimeSignInFailedError } from "./realtime.errors.ts";

interface RealtimeIdentity {
  readonly token: Redacted.Redacted<string>;
  readonly subject: string;
  readonly role: string | undefined;
}

export const realtimeSignIn = Effect.fnUntraced(function* (opts: {
  readonly url: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly email: string;
  readonly password: Redacted.Redacted<string>;
}) {
  const client = yield* HttpClient.HttpClient;
  const endpoint = `${opts.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`;

  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.setHeader("apikey", Redacted.value(opts.apiKey)),
    HttpClientRequest.bodyJsonUnsafe({
      email: opts.email,
      password: Redacted.value(opts.password),
    }),
  );

  const response = yield* client.execute(request).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new RealtimeSignInFailedError({
          message: `could not reach the Auth service at ${opts.url}: ${redactRealtimeText(String(cause))}`,
        }),
      ),
    ),
  );

  const body = yield* response.json.pipe(Effect.catch(() => Effect.succeed<unknown>({})));

  if (response.status !== 200) {
    return yield* new RealtimeSignInFailedError({
      message: `sign in failed (${response.status}): ${legacyAuthErrorText(body) ?? "no reason given"}`,
    });
  }

  const token = legacyStringField(body, "access_token");
  if (token === undefined) {
    return yield* new RealtimeSignInFailedError({
      message: "the Auth service returned no access token",
    });
  }

  const claims = legacyDecodeJwtClaims(token);
  return {
    token: Redacted.make(token),
    subject: legacyUserEmail(body) ?? legacyStringField(claims, "sub") ?? "user",
    role: legacyStringField(claims, "role"),
  } satisfies RealtimeIdentity;
});

export function realtimeTokenIdentity(token: Redacted.Redacted<string>): {
  readonly subject: string;
  readonly role: string | undefined;
  readonly expired: boolean;
} {
  const claims = legacyDecodeJwtClaims(Redacted.value(token));
  const expiry = claims?.["exp"];
  return {
    subject:
      legacyStringField(claims, "email") ?? legacyStringField(claims, "sub") ?? "unreadable token",
    role: legacyStringField(claims, "role"),
    expired: typeof expiry === "number" && expiry * 1000 < Date.now(),
  };
}

function legacyDecodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".");
  if (segments.length < 2) return undefined;
  const payload = segments[1];
  if (payload === undefined) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function legacyStringField(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function legacyUserEmail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return legacyStringField((body as Record<string, unknown>)["user"], "email");
}

function legacyAuthErrorText(body: unknown): string | undefined {
  return (
    legacyStringField(body, "error_description") ??
    legacyStringField(body, "msg") ??
    legacyStringField(body, "error")
  );
}
