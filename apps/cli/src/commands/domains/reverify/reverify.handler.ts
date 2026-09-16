import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { emitHostnameResult } from "../domains.emit.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import type { DomainsReverifyFlags } from "./reverify.command.ts";

const mapReverifyError = mapDomainsHttpError("re-verify");

export const domainsReverify = Effect.fn("domains.reverify")(function* (
  flags: DomainsReverifyFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const reverifying =
      output.format === "text" ? yield* output.task("Re-verifying custom hostname...") : undefined;
    const response = yield* api.v1.verifyDnsConfig({ ref }).pipe(
      Effect.tapError(() => reverifying?.fail() ?? Effect.void),
      Effect.catch(gateMapError({ projectRef: ref }, mapReverifyError)),
    );
    yield* reverifying?.clear() ?? Effect.void;

    yield* emitHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
