import { Effect } from "effect";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { resolveYes } from "../../command-internal/global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { LogoutCancelledError } from "./logout.errors.ts";

const LOGGED_OUT_MSG = "Access token deleted successfully. You are now logged out.";

export const logout = Effect.fn("logout")(function* () {
  const output = yield* Output;
  const credentials = yield* CommandCredentials;
  const telemetryState = yield* TelemetryState;
  // `--yes` or `SUPABASE_YES`, read before scanning stdin, so the env var auto-confirms too.
  const yes = yield* resolveYes;

  const confirmLabel =
    "Do you want to log out? This will remove the access token from your system.";

  const body = Effect.gen(function* () {
    // Confirm prompt, honoring the global `--yes`/`SUPABASE_YES`.
    const confirmed = yield* Effect.gen(function* () {
      // Machine (json/stream-json) mode without `--yes` fails loudly on a non-interactive
      // prompt rather than silently defaulting.
      if (!yes && output.format !== "text") {
        return yield* output.promptConfirm(confirmLabel, { defaultValue: false });
      }
      // `--yes`/`SUPABASE_YES` auto-confirms through the helper, including its `<label> [y/N] y`
      // stderr echo — don't short-circuit before calling it, or that echo line goes missing.
      // Without `--yes` it scans piped stdin before falling back to the default, so
      // `printf 'y\n' | supabase logout` deletes the token.
      return yield* promptYesNo(output, yes, confirmLabel, false);
    });
    if (!confirmed) {
      return yield* Effect.fail(new LogoutCancelledError({ message: CONTEXT_CANCELED_MESSAGE }));
    }

    // `NotLoggedInError` prints to stderr and exits 0 without sweeping project credentials;
    // `DeleteTokenError` propagates as exit 1.
    const notLoggedIn = yield* credentials.deleteAccessToken.pipe(
      Effect.as(false),
      Effect.catchTag("NotLoggedInError", (err) =>
        Effect.gen(function* () {
          if (output.format !== "text") {
            // Emits the message as the structured result so consumers can distinguish the
            // not-logged-in outcome from a real logout instead of an empty blob.
            yield* output.success(err.message);
          } else {
            yield* output.raw(`${err.message}\n`, "stderr");
          }
          return true;
        }),
      ),
    );
    if (notLoggedIn) {
      // Still forget the telemetry identity: a stale distinct_id can outlive
      // the token (e.g. the token file was removed manually).
      yield* telemetryState.resetIdentity;
      return;
    }

    // Best-effort sweep of all stored project DB passwords.
    yield* credentials.deleteAllProjectCredentials;

    // Forget the telemetry identity (in-process stamp + persisted distinct_id)
    // so post-logout events fall back to the anonymous device id.
    yield* telemetryState.resetIdentity;

    if (output.format !== "text") {
      yield* output.success(LOGGED_OUT_MSG);
      return;
    }
    yield* output.raw(`${LOGGED_OUT_MSG}\n`, "stdout");
  });

  // Persists telemetry state on success and failure alike.
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
