import { Effect } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  fetchCurrentPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { PostgresConfigGetFlags } from "./get.command.ts";

export const postgresConfigGet = Effect.fn("postgres-config.get")(function* (
  flags: PostgresConfigGetFlags,
) {
  const output = yield* Output;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

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
