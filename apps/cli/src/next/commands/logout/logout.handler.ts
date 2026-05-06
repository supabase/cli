import { Effect } from "effect";
import { Credentials } from "../../auth/credentials.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { clearDistinctId } from "../../../shared/telemetry/identity.ts";
import { getConfigDir } from "../../../shared/telemetry/consent.ts";

export const logout = Effect.fnUntraced(function* (yes: boolean) {
  const output = yield* Output;
  const credentials = yield* Credentials;
  const configDir = yield* getConfigDir;

  yield* output.intro("Log out of Supabase");

  if (!yes) {
    const confirmed = yield* output.promptConfirm(
      "Do you want to log out? This will remove the access token from your system.",
    );
    if (!confirmed) return;
  }

  const wasLoggedIn = yield* credentials.deleteAccessToken;
  yield* clearDistinctId(configDir);

  if (!wasLoggedIn) {
    yield* output.warn("You were not logged in, nothing to do.");
    return;
  }

  yield* output.success("Access token deleted successfully. You are now logged out.", {
    command: "logout",
  });
});
