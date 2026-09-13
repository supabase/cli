import type { Effect, Option } from "effect";
import { Context } from "effect";

import type { LoginVerificationError } from "./login.errors.ts";

/** Subset of `AccessTokenResponse` the decrypt step consumes; `id`/`created_at` are unused. */
export type LoginApiSessionResponse = {
  readonly access_token: string;
  readonly public_key: string;
  readonly nonce: string;
};

interface LoginApiShape {
  /**
   * Polls `GET {apiHost}/platform/cli/login/{sessionId}?device_code=<code>` with a 10s
   * timeout. Any transport, status, or parse failure becomes a `LoginVerificationError`
   * that drives the retry loop.
   */
  readonly fetchLoginSession: (
    apiHost: string,
    sessionId: string,
    deviceCode: string,
  ) => Effect.Effect<LoginApiSessionResponse, LoginVerificationError>;
  /**
   * Best-effort fetch of the authenticated user's `gotrue_id` from `GET {apiHost}/v1/profile`.
   * Returns `None` on any failure so the caller clears the telemetry `distinct_id`.
   */
  readonly fetchGotrueId: (apiHost: string, token: string) => Effect.Effect<Option.Option<string>>;
}

export class LoginApi extends Context.Service<LoginApi, LoginApiShape>()("supabase/cli/LoginApi") {}
