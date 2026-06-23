import { Effect, Option } from "effect";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../telemetry/legacy-telemetry-state.service.ts";
import type { NonInteractiveError } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Browser } from "../../shared/runtime/browser.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { EventLoginCompleted } from "../../shared/telemetry/event-catalog.ts";
import {
  LegacyLoginApi,
  type LegacyLoginSessionResponse,
} from "../commands/login/login-api.service.ts";
import { LegacyLoginCrypto } from "../commands/login/login-crypto.service.ts";
import { legacySuggestClaudePlugin } from "../commands/login/login-claude-hint.ts";
import {
  LegacyLoginFailedError,
  type LegacyLoginVerificationError,
} from "../commands/login/login.errors.ts";
import { legacyDashboardUrl } from "./legacy-profile.ts";
import { resolveLegacyAccessToken } from "./legacy-resolve-token.ts";

// Go's `maxRetries` (`login.go:130`): the initial probe plus 2 retries (3 total).
const MAX_LOGIN_RETRIES = 2;

export const LEGACY_LOGGED_IN_MSG = "You are now logged in. Happy coding!\n";

/**
 * Mirrors Go's `handleTelemetryAfterLogin` (`login.go:273-299`): fetch the gotrue
 * id (best-effort), stitch or clear the telemetry identity, then always capture
 * `cli_login_completed`. The capture rides the just-stitched identity so PostHog
 * attributes it to the user.
 *
 * NOTE: Go's `StitchLogin` only *aliases* — it does NOT call `identify`. Do not add
 * `analytics.identify` here; that is a `next/` behavior and would emit an event Go
 * never sends. Shared by the token path (`login`) and the browser flow.
 */
export const legacyPostLoginTelemetry = Effect.fnUntraced(function* (token: string) {
  const loginApi = yield* LegacyLoginApi;
  const telemetryState = yield* LegacyTelemetryState;
  const analytics = yield* Analytics;
  const cliConfig = yield* LegacyCliConfig;

  const gotrueId = yield* loginApi.fetchGotrueId(cliConfig.apiUrl, token);
  if (Option.isSome(gotrueId)) {
    yield* telemetryState.stitchLogin(gotrueId.value);
    yield* analytics
      .capture(EventLoginCompleted)
      .pipe(withAnalyticsContext({ distinct_id: gotrueId.value }));
  } else {
    yield* telemetryState.clearDistinctId;
    yield* analytics.capture(EventLoginCompleted);
  }
});

export interface LegacyBrowserLoginOptions {
  /** When true, prompt + open the browser; when false, just print the login link. */
  readonly openBrowser: boolean;
  /** Token name (Go's `--name`); `None` falls back to the generated default. */
  readonly tokenName: Option.Option<string>;
}

/**
 * The interactive browser login flow, extracted from `login`'s handler so
 * `bootstrap` can reuse it: generate an ECDH keypair, surface the dashboard
 * login link (optionally opening the browser), poll for the verification code
 * with Go's retry/notify cadence, decrypt + persist the token, then run the
 * post-login telemetry and print the success banners. Owns the single
 * `cli_login_completed` capture for this path.
 */
export const legacyBrowserLogin = Effect.fnUntraced(function* (opts: LegacyBrowserLoginOptions) {
  const output = yield* Output;
  const crypto = yield* LegacyLoginCrypto;
  const loginApi = yield* LegacyLoginApi;
  const credentials = yield* LegacyCredentials;
  const cliConfig = yield* LegacyCliConfig;
  const browser = yield* Browser;
  const tty = yield* Tty;

  const claudeHint = legacySuggestClaudePlugin({ stdoutIsTty: tty.stdoutIsTty });
  const apiHost = cliConfig.apiUrl;

  const { ecdh, publicKeyHex } = yield* crypto.generateKeyPair;
  const sessionId = yield* crypto.generateSessionId;
  const tokenName = Option.isSome(opts.tokenName)
    ? opts.tokenName.value
    : yield* crypto.defaultTokenName;

  // Go concatenates the query string without URL-encoding (`login.go:197-198`).
  const loginUrl =
    `${legacyDashboardUrl(cliConfig.profile)}/cli/login` +
    `?session_id=${sessionId}&token_name=${tokenName}&public_key=${publicKeyHex}`;

  // The banners are human-facing text — suppressed in json / stream-json so
  // stdout stays payload-only. The prompts still run (and fail cleanly with
  // `NonInteractiveError` in a non-interactive machine mode).
  const isText = output.format === "text";
  if (opts.openBrowser) {
    if (isText) {
      yield* output.raw(
        "Hello from Supabase! Press Enter to open browser and login automatically.\n",
        "stdout",
      );
    }
    yield* output.promptText("");
    if (isText) {
      yield* output.raw(
        `Here is your login link in case browser did not open ${loginUrl}\n\n`,
        "stdout",
      );
    }
    yield* Effect.ignore(browser.open(loginUrl));
  } else if (isText) {
    yield* output.raw(`Here is your login link, open it in the browser ${loginUrl}\n\n`, "stdout");
  }

  // Verify + retry, mirroring Go's `pollForAccessToken` backoff
  // (`login.go:132-166`): the notifier prints `<err>\nRetry (n/2): ` after the
  // first 2 failures; the 3rd failure gives up without a notice.
  const verifyWithRetries = (
    failuresSoFar: number,
  ): Effect.Effect<
    LegacyLoginSessionResponse,
    LegacyLoginFailedError | NonInteractiveError,
    Output | LegacyLoginApi
  > =>
    Effect.gen(function* () {
      const code = yield* output.promptText("Enter your verification code: ", {
        validate: (v) => (v.trim().length > 0 ? undefined : "Verification code is required"),
      });
      return yield* loginApi.fetchLoginSession(apiHost, sessionId, code.trim());
    }).pipe(
      Effect.catchTag("LegacyLoginVerificationError", (err: LegacyLoginVerificationError) =>
        Effect.gen(function* () {
          const failures = failuresSoFar + 1;
          if (failures > MAX_LOGIN_RETRIES) {
            return yield* Effect.fail(new LegacyLoginFailedError({ message: err.message }));
          }
          yield* output.raw(`${err.message}\nRetry (${failures}/${MAX_LOGIN_RETRIES}): `, "stderr");
          return yield* verifyWithRetries(failures);
        }),
      ),
    );

  const session = yield* verifyWithRetries(0);

  const token = yield* crypto.decryptToken(ecdh, {
    ciphertext: session.access_token,
    publicKey: session.public_key,
    nonce: session.nonce,
  });
  // Go returns the raw save error here (`login.go:222-224`) — not the
  // "cannot save provided token" wrapper used on the token path.
  yield* credentials.saveAccessToken(token);
  yield* legacyPostLoginTelemetry(token);

  if (output.format !== "text") {
    yield* output.success("You are now logged in.", { token_name: tokenName });
    return;
  }
  yield* output.raw(`Token ${tokenName} created successfully.\n\n`, "stdout");
  yield* output.raw(LEGACY_LOGGED_IN_MSG, "stdout");
  if (claudeHint.length > 0) yield* output.raw(`${claudeHint}\n`, "stderr");
});

/**
 * Ensures a Management API access token exists. Mirrors Go's `bootstrap` login
 * step (`bootstrap.go:67-77`): if a token is already resolvable (env / keyring /
 * file) it is a no-op; otherwise the browser login flow runs and fires
 * `cli_login_completed` once.
 */
export const legacyEnsureLogin = Effect.fnUntraced(function* (opts: { openBrowser: boolean }) {
  const existing = yield* resolveLegacyAccessToken;
  if (Option.isSome(existing)) {
    return;
  }
  yield* legacyBrowserLogin({ openBrowser: opts.openBrowser, tokenName: Option.none() });
});
