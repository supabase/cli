import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { emitLegacyHostnameResult } from "../domains.emit.ts";
import { mapLegacyDomainsHttpError } from "../domains.errors.ts";
import type { LegacyDomainsActivateFlags } from "./activate.command.ts";

const mapActivateError = mapLegacyDomainsHttpError("activate");

export const legacyDomainsActivate = Effect.fn("legacy.domains.activate")(function* (
  flags: LegacyDomainsActivateFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const activating =
      output.format === "text" ? yield* output.task("Activating custom hostname...") : undefined;
    const response = yield* api.v1.activateCustomHostname({ ref }).pipe(
      Effect.tapError(() => activating?.fail() ?? Effect.void),
      Effect.catch(mapActivateError),
    );
    yield* activating?.clear() ?? Effect.void;

    yield* emitLegacyHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
