import { Effect } from "effect";
import { remotesList } from "../../../../shared/remotes/remotes-crud.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";

export const legacyRemotesList = Effect.fn("legacy.remotes.list")(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;

  yield* remotesList(cliConfig.workdir).pipe(Effect.ensuring(telemetryState.flush));
});
