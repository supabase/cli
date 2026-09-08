import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { emitHostnameResult } from "../domains.emit.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import type { DomainsActivateFlags } from "./activate.command.ts";

const mapActivateError = mapDomainsHttpError("activate");

export const domainsActivate = Effect.fn("domains.activate")(function* (
  flags: DomainsActivateFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const activating =
      output.format === "text" ? yield* output.task("Activating custom hostname...") : undefined;
    const response = yield* api.v1.activateCustomHostname({ ref }).pipe(
      Effect.tapError(() => activating?.fail() ?? Effect.void),
      Effect.catch(gateMapError({ projectRef: ref }, mapActivateError)),
    );
    yield* activating?.clear() ?? Effect.void;

    yield* emitHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
