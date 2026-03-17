import { Data, Effect, Option, Redacted } from "effect";
import { UrlParams } from "effect/unstable/http";
import { validateToken } from "../../auth/token.ts";
import { CliConfig } from "../../config/cli-config.service.ts";
import { Output } from "../../output/output.service.ts";
import { Api } from "../../auth/api.service.ts";
import type { LoginSessionResponse } from "../../auth/api.service.ts";
import type { ApiError } from "../../auth/errors.ts";
import { Credentials } from "../../auth/credentials.service.ts";
import { Crypto } from "../../auth/crypto.service.ts";
import { Browser } from "../../runtime/browser.service.ts";
import { Stdin } from "../../runtime/stdin.service.ts";
import type { NonInteractiveError } from "../../output/errors.ts";
import { LoginFailedError, NoTtyError } from "./login.errors.ts";
import type { LoginFlags } from "./login.command.ts";

class LoginVerificationError extends Data.TaggedError("LoginVerificationError")<{
  cause: ApiError;
}> {}

const MAX_LOGIN_VERIFICATION_RETRIES = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const revealToken = (token: Redacted.Redacted<string>): string => Redacted.value(token);

const saveDirectToken = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
  const credentials = yield* Credentials;
  const output = yield* Output;
  yield* validateToken(revealToken(token));
  yield* credentials.saveAccessToken(token);
  yield* output.success("Logged in successfully.", { command: "login" });
});

// Token resolution priority: --token flag > SUPABASE_ACCESS_TOKEN env > piped stdin > interactive browser flow
const resolveToken = Effect.fnUntraced(function* (tokenFlag: Option.Option<string>) {
  if (Option.isSome(tokenFlag)) return Option.some(Redacted.make(tokenFlag.value));

  const cliConfig = yield* CliConfig;
  if (Option.isSome(cliConfig.accessToken)) return cliConfig.accessToken;

  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* stdin.readPipedText;
    if (Option.isSome(piped)) return Option.some(Redacted.make(piped.value));
    return yield* new NoTtyError({
      detail: "Cannot prompt for token in non-interactive mode",
      suggestion: "Pass --token or set SUPABASE_ACCESS_TOKEN",
    });
  }

  return Option.none();
});

// ---------------------------------------------------------------------------
// Browser OAuth flow
// ---------------------------------------------------------------------------

const browserOAuthFlow = Effect.fnUntraced(function* (flags: LoginFlags) {
  const credentials = yield* Credentials;
  const api = yield* Api;
  const crypto = yield* Crypto;
  const browser = yield* Browser;
  const output = yield* Output;

  // Check if already logged in
  const existingToken = yield* credentials.getAccessToken;
  if (Option.isSome(existingToken)) {
    yield* output.warn("You are already logged in.");
    const shouldContinue = yield* output.promptConfirm(
      "Do you want to log in with a different account?",
    );
    if (!shouldContinue) {
      yield* output.outro("Already logged in.");
      return;
    }
  }

  const cliConfig = yield* CliConfig;
  const apiUrl = cliConfig.apiUrl;
  const dashboardUrl = cliConfig.dashboardUrl;

  const { ecdh, publicKeyHex } = yield* crypto.generateKeyPair;
  const sessionId = yield* crypto.generateSessionId;
  const tokenName = Option.isSome(flags.name) ? flags.name.value : yield* crypto.defaultTokenName;

  const loginUrl = yield* UrlParams.makeUrl(
    `${dashboardUrl}/cli/login`,
    UrlParams.fromInput({
      session_id: sessionId,
      token_name: tokenName,
      public_key: publicKeyHex,
    }),
    undefined,
  ).pipe(
    Effect.fromResult,
    Effect.map((url) => url.toString()),
  );

  if (!flags.noBrowser) {
    yield* output.promptText("Press Enter to open browser and log in.", { defaultValue: "" });
    yield* output.info(`Here is your login link in case browser did not open\n${loginUrl}`);
    yield* Effect.ignore(browser.open(loginUrl));
  } else {
    yield* output.info(`Here is your login link, open it in the browser\n${loginUrl}`);
  }

  const verifyCode = Effect.gen(function* () {
    const deviceCode = yield* output.promptText("Enter your verification code", {
      validate: (v) => {
        if (!v?.trim()) return "Verification code is required";
      },
    });
    return yield* api
      .fetchLoginSession(apiUrl, sessionId, deviceCode.trim())
      .pipe(Effect.mapError((cause) => new LoginVerificationError({ cause })));
  });

  const verifyWithRetries = (
    remainingRetries: number,
  ): Effect.Effect<LoginSessionResponse, LoginFailedError | NonInteractiveError> =>
    verifyCode.pipe(
      Effect.catchTag("LoginVerificationError", () =>
        Effect.gen(function* () {
          yield* output.error("Verification failed");
          if (remainingRetries <= 0) {
            return yield* Effect.fail(
              new LoginFailedError({
                detail: "Login failed after maximum retries",
                suggestion: "Try running `supabase login` again",
              }),
            );
          }
          return yield* verifyWithRetries(remainingRetries - 1);
        }),
      ),
    );

  const session = yield* verifyWithRetries(MAX_LOGIN_VERIFICATION_RETRIES);

  const token = yield* crypto.decryptToken(ecdh, {
    ciphertext: session.access_token,
    publicKey: session.public_key,
    nonce: session.nonce,
  });
  yield* validateToken(token);
  yield* credentials.saveAccessToken(Redacted.make(token));

  yield* output.success(`Token ${tokenName} created successfully.`, {
    command: "login",
    tokenName,
  });
  yield* output.outro("You are now logged in. Happy coding!");
});

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const login = Effect.fnUntraced(function* (flags: LoginFlags) {
  const output = yield* Output;
  yield* output.intro("Log in to Supabase");

  const resolved = yield* resolveToken(flags.token);
  if (Option.isSome(resolved)) {
    return yield* saveDirectToken(resolved.value);
  }
  return yield* browserOAuthFlow(flags);
});
