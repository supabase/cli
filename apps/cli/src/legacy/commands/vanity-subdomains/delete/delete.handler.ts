import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyVanitySubdomainsDeleteNetworkError,
  LegacyVanitySubdomainsDeleteUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { LegacyVanitySubdomainsDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapLegacyHttpError({
  networkError: LegacyVanitySubdomainsDeleteNetworkError,
  statusError: LegacyVanitySubdomainsDeleteUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected delete vanity subdomain status ${status}: ${body}`,
});

export const legacyVanitySubdomainsDelete = Effect.fn("legacy.vanity-subdomains.delete")(function* (
  flags: LegacyVanitySubdomainsDeleteFlags,
) {
  const output = yield* Output;
  const legacyOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const deleting =
        output.format === "text" ? yield* output.task("Deleting vanity subdomain...") : undefined;
      yield* api.v1.deactivateVanitySubdomainConfig({ ref }).pipe(
        Effect.tapError(() => deleting?.fail() ?? Effect.void),
        Effect.catch(mapDeleteError),
      );
      yield* deleting?.clear() ?? Effect.void;

      // Go's delete ignores --output entirely (stderr-only success). We still read
      // the legacy flag so that an explicit --output suppresses the TS json/stream-json
      // success event, matching Go's behavior of emitting nothing to stdout.
      const legacyOutput = Option.getOrUndefined(legacyOutputFlag);

      if (
        legacyOutput === undefined &&
        (output.format === "json" || output.format === "stream-json")
      ) {
        yield* output.success("Deleted vanity subdomain successfully.");
        return;
      }

      yield* output.raw("Deleted vanity subdomain successfully.\n", "stderr");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
