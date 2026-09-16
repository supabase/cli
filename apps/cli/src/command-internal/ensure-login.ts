import { Effect, Option } from "effect";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import type { NonInteractiveError } from "../shared/output/errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { Browser } from "../shared/runtime/browser.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../shared/telemetry/analytics-context.ts";
import { EventLoginCompleted } from "../shared/telemetry/event-catalog.ts";
import { LoginApi, type LoginApiSessionResponse } from "../commands/login/login-api.service.ts";
import { LoginCrypto } from "../commands/login/login-crypto.service.ts";
import { suggestClaudePlugin } from "../commands/login/login-claude-hint.ts";
import { LoginFailedError, type LoginVerificationError } from "../commands/login/login.errors.ts";
import { dashboardUrl } from "./profile.ts";
import { resolveAccessToken } from "./resolve-token.ts";

// Initial probe plus 2 retries (3 total).
const MAX_LOGIN_RETRIES = 2;

export const LOGGED_IN_MSG = "You are now logged in. Happy coding!\n";

/**
 * Fetches the gotrue id (best-effort), stitches or clears the telemetry identity, then always
 * captures `cli_login_completed`, riding the just-stitched identity so PostHog attributes it to
 * the user.
 *
 * `stitchLogin` only aliases — it does not call `identify`. Do not add `analytics.identify` here;
 * it would emit an event the established telemetry never sends.
 */
export const postLoginTelemetry = Effect.fnUntraced(function* (token: string) {
  const loginApi = yield* LoginApi;
  const telemetryState = yield* TelemetryState;
  const analytics = yield* Analytics;
  const cliSettings = yield* CommandSettings;

  const gotrueId = yield* loginApi.fetchGotrueId(cliSettings.apiUrl, token);
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

export interface BrowserLoginOptions {
  /** When true, prompt + open the browser; when false, just print the login link. */
  readonly openBrowser: boolean;
  /** Token name (`--name`); `None` falls back to the generated default. */
  readonly tokenName: Option.Option<string>;
}

/**
 * The interactive browser login flow, shared by `login` and `bootstrap`: generates an ECDH
 * keypair, surfaces the dashboard login link (optionally opening the browser), polls for the
 * verification code with a retry/notify cadence, decrypts and persists the token, then runs the
 * post-login telemetry and prints the success banners. Owns the single `cli_login_completed`
 * capture for this path.
 */
export const browserLogin = Effect.fnUntraced(function* (opts: BrowserLoginOptions) {
  const output = yield* Output;
  const crypto = yield* LoginCrypto;
  const loginApi = yield* LoginApi;
  const credentials = yield* CommandCredentials;
  const cliSettings = yield* CommandSettings;
  const browser = yield* Browser;
  const tty = yield* Tty;

  const claudeHint = suggestClaudePlugin({ stdoutIsTty: tty.stdoutIsTty });
  const apiHost = cliSettings.apiUrl;

  const { ecdh, publicKeyHex } = yield* crypto.generateKeyPair;
  const sessionId = yield* crypto.generateSessionId;
  const tokenName = Option.isSome(opts.tokenName)
    ? opts.tokenName.value
    : yield* crypto.defaultTokenName;

  // Established behavior: the query string is concatenated without URL-encoding.
  const loginUrl =
    `${dashboardUrl(cliSettings.profile)}/cli/login` +
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

  // Verify with retry: prints `<err>\nRetry (n/2): ` after each of the first 2 failures; the 3rd
  // failure gives up without a notice.
  const verifyWithRetries = (
    failuresSoFar: number,
  ): Effect.Effect<
    LoginApiSessionResponse,
    LoginFailedError | NonInteractiveError,
    Output | LoginApi
  > =>
    Effect.gen(function* () {
      const code = yield* output.promptText("Enter your verification code: ", {
        validate: (v) => (v.trim().length > 0 ? undefined : "Verification code is required"),
      });
      return yield* loginApi.fetchLoginSession(apiHost, sessionId, code.trim());
    }).pipe(
      Effect.catchTag("LoginVerificationError", (err: LoginVerificationError) =>
        Effect.gen(function* () {
          const failures = failuresSoFar + 1;
          if (failures > MAX_LOGIN_RETRIES) {
            return yield* Effect.fail(
              new LoginFailedError({
                message: err.message,
                statusCode: err.statusCode,
                network: err.network,
                decode: err.decode,
              }),
            );
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
  // Returns the raw save error here, not the "cannot save provided token" wrapper used on the
  // token path.
  yield* credentials.saveAccessToken(token);
  yield* postLoginTelemetry(token);

  if (output.format !== "text") {
    yield* output.success("You are now logged in.", { token_name: tokenName });
    return;
  }
  yield* output.raw(`Token ${tokenName} created successfully.\n\n`, "stdout");
  yield* output.raw(LOGGED_IN_MSG, "stdout");
  if (claudeHint.length > 0) yield* output.raw(`${claudeHint}\n`, "stderr");
});

/**
 * Ensures a Management API access token exists: a no-op if a token is already resolvable
 * (env/keyring/file), otherwise runs the browser login flow and fires `cli_login_completed`
 * once.
 */
export const ensureLogin = Effect.fnUntraced(function* (opts: { openBrowser: boolean }) {
  const existing = yield* resolveAccessToken;
  if (Option.isSome(existing)) {
    return;
  }
  yield* browserLogin({ openBrowser: opts.openBrowser, tokenName: Option.none() });
});
