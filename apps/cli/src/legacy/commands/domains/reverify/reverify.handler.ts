import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { emitLegacyHostnameResult } from "../domains.emit.ts";
import { mapLegacyDomainsHttpError } from "../domains.errors.ts";
import type { LegacyDomainsReverifyFlags } from "./reverify.command.ts";

const mapReverifyError = mapLegacyDomainsHttpError("re-verify");

export const legacyDomainsReverify = Effect.fn("legacy.domains.reverify")(function* (
  flags: LegacyDomainsReverifyFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const reverifying =
      output.format === "text" ? yield* output.task("Re-verifying custom hostname...") : undefined;
    const response = yield* api.v1.verifyDnsConfig({ ref }).pipe(
      Effect.tapError(() => reverifying?.fail() ?? Effect.void),
      Effect.catch(mapReverifyError),
    );
    yield* reverifying?.clear() ?? Effect.void;

    yield* emitLegacyHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
