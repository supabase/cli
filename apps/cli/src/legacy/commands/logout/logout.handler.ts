import { Effect } from "effect";

import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYes } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { legacyPromptYesNo } from "../../shared/legacy-prompt-yes-no.ts";
import { LegacyLogoutCancelledError, LEGACY_LOGOUT_CANCELLED_MESSAGE } from "./logout.errors.ts";

const LOGGED_OUT_MSG = "Access token deleted successfully. You are now logged out.";

export const legacyLogout = Effect.fn("legacy.logout")(function* () {
  const output = yield* Output;
  const credentials = yield* LegacyCredentials;
  const telemetryState = yield* LegacyTelemetryState;
  // `--yes` OR `SUPABASE_YES` (Go's `viper.GetBool("YES")`, root.go:318-320): Go
  // reads it before scanning stdin, so the env var auto-confirms logout too.
  const yes = yield* legacyResolveYes;

  const confirmLabel =
    "Do you want to log out? This will remove the access token from your system.";

  const body = Effect.gen(function* () {
    // Confirm prompt, honoring the global `--yes`/`SUPABASE_YES` (`logout.go:15-16`).
    const confirmed = yield* Effect.gen(function* () {
      if (yes) return true;
      // Machine (json/stream-json) mode has no Go equivalent — fail loudly on a
      // non-interactive prompt rather than silently defaulting, preserving the
      // existing contract.
      if (output.format !== "text") {
        return yield* output.promptConfirm(confirmLabel, { defaultValue: false });
      }
      // Text mode mirrors Go's `PromptYesNo(..., false)` (`logout.go:16`): it scans
      // piped stdin before falling back to the default (`console.go:64-82`), so
      // `printf 'y\n' | supabase logout` deletes the token.
      return yield* legacyPromptYesNo(output, yes, confirmLabel, false);
    });
    if (!confirmed) {
      return yield* Effect.fail(
        new LegacyLogoutCancelledError({ message: LEGACY_LOGOUT_CANCELLED_MESSAGE }),
      );
    }

    // Delete the access token. `LegacyNotLoggedInError` is the not-logged-in
    // path (print to stderr, exit 0, and do NOT sweep project credentials —
    // Go returns before `DeleteAll`, `logout.go:21-23`). `LegacyDeleteTokenError`
    // propagates as exit 1 (`logout.go:24-26`).
    const notLoggedIn = yield* credentials.deleteAccessToken.pipe(
      Effect.as(false),
      Effect.catchTag("LegacyNotLoggedInError", (err) =>
        Effect.gen(function* () {
          if (output.format !== "text") {
            // Machine modes have no Go equivalent (Go is text-only). Emit the
            // message as the structured result so consumers can distinguish the
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

    // Best-effort sweep of all stored project DB passwords (`logout.go:29-31`).
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

  // PersistentPostRun parity: persist telemetry state on success and failure.
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
