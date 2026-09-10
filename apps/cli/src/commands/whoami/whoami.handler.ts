import type { V1GetProfileOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/go-output-flag.ts";
import {
  AUTHENTICATION_FAILED_STATUS_MESSAGE,
  mapHttpError,
} from "../../command-internal/http-errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  WhoamiNetworkError,
  WhoamiOutputFlagUnsupportedError,
  WhoamiUnexpectedStatusError,
} from "./whoami.errors.ts";
import { renderWhoamiTable } from "./whoami.format.ts";
import type { WhoamiFlags } from "./whoami.command.ts";

const mapProfileError = mapHttpError({
  networkError: WhoamiNetworkError,
  statusError: WhoamiUnexpectedStatusError,
  networkMessage: (cause) => `failed to fetch user profile: ${cause}`,
  statusMessage: (status, body) =>
    status === 401
      ? AUTHENTICATION_FAILED_STATUS_MESSAGE
      : `unexpected get profile status ${status}: ${body}`,
});

type Profile = typeof V1GetProfileOutput.Type;

/**
 * Projects the Management API response into whoami's intentionally bare public
 * profile contract.
 *
 * Keep this projection explicit so API field names cannot leak into the CLI payload.
 */
const emitMachineProfile = Effect.fnUntraced(function* (profile: Profile) {
  const output = yield* Output;
  yield* output.result({
    id: profile.gotrue_id,
    email: profile.primary_email,
    username: profile.username,
  });
});

export const whoami = Effect.fn("whoami")(function* (_flags: WhoamiFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    if (Option.isSome(goOutputFlag)) {
      return yield* new WhoamiOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("whoami"),
      });
    }

    const fetching =
      output.format === "text" ? yield* output.task("Fetching user profile...") : undefined;
    const profile = yield* api.v1.getProfile().pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapProfileError),
    );
    yield* fetching?.clear() ?? Effect.void;

    if (output.format !== "text") {
      yield* emitMachineProfile(profile);
      return;
    }

    yield* output.raw(renderWhoamiTable(profile));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
