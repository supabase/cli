import { Effect } from "effect";
import { remotesAdd } from "../../../../shared/remotes/remotes-crud.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyRemotesAddFlags } from "./add.command.ts";

export const legacyRemotesAdd = Effect.fn("legacy.remotes.add")(function* (
  flags: LegacyRemotesAddFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;

  yield* remotesAdd(cliConfig.workdir, flags.name, flags.projectRef).pipe(
    Effect.ensuring(telemetryState.flush),
  );
});
