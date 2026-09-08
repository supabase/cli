import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { emitHostnameResult } from "../domains.emit.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import type { DomainsGetFlags } from "./get.command.ts";

const mapGetError = mapDomainsHttpError("get");

export const domainsGet = Effect.fn("domains.get")(function* (flags: DomainsGetFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Write the linked-project cache and persist the telemetry state file on
  // success and failure.
  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text"
        ? yield* output.task("Fetching custom hostname config...")
        : undefined;
    const response = yield* api.v1.getHostnameConfig({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(gateMapError({ projectRef: ref }, mapGetError)),
    );
    yield* fetching?.clear() ?? Effect.void;

    yield* emitHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
