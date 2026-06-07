import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { saveLegacyProfileName } from "../../config/legacy-profile-file.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDashboardUrl } from "../../shared/legacy-profile.ts";
import { LegacyProfileFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { NonInteractiveError } from "../../../shared/output/errors.ts";
import { Browser } from "../../../shared/runtime/browser.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { EventLoginCompleted } from "../../../shared/telemetry/event-catalog.ts";
import { LegacyLoginApi, type LegacyLoginSessionResponse } from "./login-api.service.ts";
import { LegacyLoginCrypto } from "./login-crypto.service.ts";
import { legacySuggestClaudePlugin } from "./login-claude-hint.ts";
import {
  LEGACY_LOGIN_MISSING_TOKEN_MESSAGE,
  LegacyLoginFailedError,
  LegacyLoginMissingTokenError,
  LegacyLoginSaveTokenError,
} from "./login.errors.ts";
import type { LegacyLoginFlags } from "./login.command.ts";

// Go's `maxRetries` (`login.go:130`): the initial probe plus 2 retries (3 total).
const MAX_LOGIN_RETRIES = 2;

const LOGGED_IN_MSG = "You are now logged in. Happy coding!\n";

export const legacyLogin = Effect.fn("legacy.login")(function* (flags: LegacyLoginFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;
  const crypto = yield* LegacyLoginCrypto;
  const loginApi = yield* LegacyLoginApi;
  const telemetryState = yield* LegacyTelemetryState;
  const analytics = yield* Analytics;
  const browser = yield* Browser;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const profileFlag = yield* LegacyProfileFlag;

  const apiHost = cliConfig.apiUrl;
  const claudeHint = legacySuggestClaudePlugin({ stdoutIsTty: tty.stdoutIsTty });

  // Mirrors Go's login `PostRunE` (`cmd/login.go:42-48`): when a profile was
  // explicitly chosen (`--profile` over its default, else `SUPABASE_PROFILE`),
  // persist it to `~/.supabase/profile` on success so later commands resolve the
  // same profile. The raw token is written (Go's `viper.GetString("PROFILE")`),
  // so a YAML-path profile round-trips. A write failure is fatal (Go: "Failure
  // to save should block subsequent commands on CI").
  const envProfile = process.env["SUPABASE_PROFILE"];
  const profileToken =
    profileFlag !== "supabase"
      ? profileFlag
      : envProfile !== undefined && envProfile.length > 0
        ? envProfile
        : undefined;
  const saveProfileName =
    profileToken === undefined
      ? Effect.void
      : saveLegacyProfileName(fs, path, runtimeInfo.homeDir, profileToken);

  // Mirrors Go's `handleTelemetryAfterLogin` (`login.go:273-299`): fetch the
  // gotrue id (best-effort), stitch or clear the telemetry identity, then always
  // capture `cli_login_completed`. The capture rides the just-stitched identity
  // so PostHog attributes it to the user (Go's `s.distinctID()` after StitchLogin).
  //
  // NOTE: Go's `StitchLogin` only *aliases* (`service.go:137`) — it does NOT
  // call `identify`. Do not add `analytics.identify` here; that is a `next/`
  // shell behavior and would emit an event Go never sends.
  const postLoginTelemetry = (token: string) =>
    Effect.gen(function* () {
      const gotrueId = yield* loginApi.fetchGotrueId(apiHost, token);
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

  const tokenPath = (token: string) =>
    Effect.gen(function* () {
      yield* credentials.saveAccessToken(token).pipe(
        Effect.catchTag("LegacyInvalidAccessTokenError", (cause) =>
          Effect.fail(
            new LegacyLoginSaveTokenError({
              message: `cannot save provided token: ${cause.message}`,
            }),
          ),
        ),
      );
      yield* postLoginTelemetry(token);

      if (output.format !== "text") {
        yield* output.success("You are now logged in.");
        return;
      }
      yield* output.raw(LOGGED_IN_MSG, "stdout");
      if (claudeHint.length > 0) yield* output.raw(`${claudeHint}\n`, "stderr");
    });

  const browserPath = Effect.gen(function* () {
    const { ecdh, publicKeyHex } = yield* crypto.generateKeyPair;
    const sessionId = yield* crypto.generateSessionId;
    const tokenName = Option.isSome(flags.name) ? flags.name.value : yield* crypto.defaultTokenName;

    // Go concatenates the query string without URL-encoding (`login.go:197-198`).
    const loginUrl =
      `${legacyDashboardUrl(cliConfig.profile)}/cli/login` +
      `?session_id=${sessionId}&token_name=${tokenName}&public_key=${publicKeyHex}`;

    // The banners are human-facing text — suppressed in json / stream-json so
    // stdout stays payload-only. The prompts still run (and fail cleanly with
    // `NonInteractiveError` in a non-interactive machine mode).
    const isText = output.format === "text";
    if (!flags.noBrowser) {
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
      yield* output.raw(
        `Here is your login link, open it in the browser ${loginUrl}\n\n`,
        "stdout",
      );
    }

    // Verify + retry, mirroring Go's `pollForAccessToken` backoff
    // (`login.go:132-166`): the notifier prints `<err>\nRetry (n/2): ` after the
    // first 2 failures; the 3rd failure gives up without a notice.
    const verifyWithRetries = (
      failuresSoFar: number,
    ): Effect.Effect<LegacyLoginSessionResponse, LegacyLoginFailedError | NonInteractiveError> =>
      Effect.gen(function* () {
        const code = yield* output.promptText("Enter your verification code: ", {
          validate: (v) => (v.trim().length > 0 ? undefined : "Verification code is required"),
        });
        return yield* loginApi.fetchLoginSession(apiHost, sessionId, code.trim());
      }).pipe(
        Effect.catchTag("LegacyLoginVerificationError", (err) =>
          Effect.gen(function* () {
            const failures = failuresSoFar + 1;
            if (failures > MAX_LOGIN_RETRIES) {
              return yield* Effect.fail(new LegacyLoginFailedError({ message: err.message }));
            }
            yield* output.raw(
              `${err.message}\nRetry (${failures}/${MAX_LOGIN_RETRIES}): `,
              "stderr",
            );
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
    yield* postLoginTelemetry(token);

    if (output.format !== "text") {
      yield* output.success("You are now logged in.", { token_name: tokenName });
      return;
    }
    yield* output.raw(`Token ${tokenName} created successfully.\n\n`, "stdout");
    yield* output.raw(LOGGED_IN_MSG, "stdout");
    if (claudeHint.length > 0) yield* output.raw(`${claudeHint}\n`, "stderr");
  });

  const body = Effect.gen(function* () {
    // Token resolution priority: --token → SUPABASE_ACCESS_TOKEN → piped stdin
    // (non-TTY only). Matches `cmd/login.go:31-39` + `login.go:236-247`.
    const resolved = yield* resolveToken(flags);
    if (Option.isSome(resolved)) {
      return yield* tokenPath(resolved.value);
    }
    return yield* browserPath;
  });

  // `Effect.tap` runs the profile save only on success (Go's `PostRunE`);
  // `Effect.ensuring` persists telemetry state on success and failure alike
  // (PersistentPostRun parity, `cmd/root.go:176`).
  return yield* body.pipe(
    Effect.tap(() => saveProfileName),
    Effect.ensuring(telemetryState.flush),
  );
});

const resolveToken = Effect.fnUntraced(function* (flags: LegacyLoginFlags) {
  if (Option.isSome(flags.token)) return Option.some(flags.token.value);
  const cliConfig = yield* LegacyCliConfig;
  if (Option.isSome(cliConfig.accessToken)) {
    return Option.some(Redacted.value(cliConfig.accessToken.value));
  }
  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* stdin.readPipedText;
    if (Option.isSome(piped)) return Option.some(piped.value);
    return yield* Effect.fail(
      new LegacyLoginMissingTokenError({ message: LEGACY_LOGIN_MISSING_TOKEN_MESSAGE }),
    );
  }
  return Option.none<string>();
});
