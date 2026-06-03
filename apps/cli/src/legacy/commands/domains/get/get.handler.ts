import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { emitLegacyHostnameResult } from "../domains.emit.ts";
import { mapLegacyDomainsHttpError } from "../domains.errors.ts";
import type { LegacyDomainsGetFlags } from "./get.command.ts";

const mapGetError = mapLegacyDomainsHttpError("get");

export const legacyDomainsGet = Effect.fn("legacy.domains.get")(function* (
  flags: LegacyDomainsGetFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Mirror Go's PersistentPostRun: write the linked-project cache and persist
  // the telemetry state file on success and failure.
  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text"
        ? yield* output.task("Fetching custom hostname config...")
        : undefined;
    const response = yield* api.v1.getHostnameConfig({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapGetError),
    );
    yield* fetching?.clear() ?? Effect.void;

    yield* emitLegacyHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
