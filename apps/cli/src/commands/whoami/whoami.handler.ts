import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { mapHttpError } from "../../command-internal/http-errors.ts";
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
  statusMessage: (status, body) => `unexpected get profile status ${status}: ${body}`,
});

export const whoami = Effect.fn("whoami")(function* (_flags: WhoamiFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    if (Option.isSome(goOutputFlag)) {
      return yield* new WhoamiOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by whoami; use --output-format json|stream-json instead.",
      });
    }

    const fetching =
      output.format === "text" ? yield* output.task("Fetching user profile...") : undefined;
    const profile = yield* api.v1.getProfile().pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapProfileError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const machineProfile = {
      id: profile.gotrue_id,
      email: profile.primary_email,
      username: profile.username,
    };

    if (output.format === "json") {
      yield* output.raw(`${JSON.stringify(machineProfile)}\n`);
      return;
    }

    if (output.format === "stream-json") {
      yield* output.event({
        type: "result",
        data: machineProfile,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    yield* output.raw(renderWhoamiTable(profile));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
