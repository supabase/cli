import { Effect } from "effect";
import { remotesRemove } from "../../../../shared/remotes/remotes-crud.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyRemotesRemoveFlags } from "./remove.command.ts";

export const legacyRemotesRemove = Effect.fn("legacy.remotes.remove")(function* (
  flags: LegacyRemotesRemoveFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;

  yield* remotesRemove(cliConfig.workdir, flags.name).pipe(Effect.ensuring(telemetryState.flush));
});
