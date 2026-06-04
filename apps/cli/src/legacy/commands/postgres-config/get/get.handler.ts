import { Effect } from "effect";

import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  fetchCurrentPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { LegacyPostgresConfigGetFlags } from "./get.command.ts";

export const legacyPostgresConfigGet = Effect.fn("legacy.postgres-config.get")(function* (
  flags: LegacyPostgresConfigGetFlags,
) {
  const output = yield* Output;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Fetching Postgres config...") : undefined;
      const config = yield* fetchCurrentPostgresConfig(ref).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      yield* fetching?.clear() ?? Effect.void;
      yield* writePostgresConfigOutput(config);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
