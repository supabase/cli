import type { Effect, Option } from "effect";
import { Context } from "effect";

import type { LegacyLoginVerificationError } from "./login.errors.ts";

/**
 * Subset of Go's `AccessTokenResponse` (`login.go:39-45`) the decrypt step
 * consumes. `id` / `created_at` are returned by the API but unused.
 */
export type LegacyLoginSessionResponse = {
  readonly access_token: string;
  readonly public_key: string;
  readonly nonce: string;
};

interface LegacyLoginApiShape {
  /**
   * Polls `GET {apiHost}/platform/cli/login/{sessionId}?device_code=<code>`
   * (Go's `pollForAccessToken`, `login.go:132-157`). Expects HTTP 200 with a
   * 10s timeout; any transport / status / parse failure becomes a
   * `LegacyLoginVerificationError` that drives the retry loop.
   */
  readonly fetchLoginSession: (
    apiHost: string,
    sessionId: string,
    deviceCode: string,
  ) => Effect.Effect<LegacyLoginSessionResponse, LegacyLoginVerificationError>;
  /**
   * Best-effort fetch of the authenticated user's `gotrue_id` from
   * `GET {apiHost}/v1/profile` (Go's `getProfileGotrueID`, `login.go:301-310`).
   * Returns `None` on any failure so the caller clears the telemetry
   * `distinct_id`, matching Go's `handleTelemetryAfterLogin` error branch.
   */
  readonly fetchGotrueId: (apiHost: string, token: string) => Effect.Effect<Option.Option<string>>;
}

export class LegacyLoginApi extends Context.Service<LegacyLoginApi, LegacyLoginApiShape>()(
  "supabase/legacy/LoginApi",
) {}
