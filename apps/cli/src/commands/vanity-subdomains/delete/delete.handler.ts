import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  VanitySubdomainsDeleteNetworkError,
  VanitySubdomainsDeleteUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { VanitySubdomainsDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapHttpError({
  networkError: VanitySubdomainsDeleteNetworkError,
  statusError: VanitySubdomainsDeleteUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected delete vanity subdomain status ${status}: ${body}`,
});

export const vanitySubdomainsDelete = Effect.fn("vanity-subdomains.delete")(function* (
  flags: VanitySubdomainsDeleteFlags,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

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

      // `--output` is ignored entirely (stderr-only success). We still read
      // the legacy flag so that an explicit --output suppresses the TS json/stream-json
      // success event, keeping stdout empty either way.
      const goOutput = Option.getOrUndefined(outputFlag);

      if (goOutput === undefined && (output.format === "json" || output.format === "stream-json")) {
        yield* output.success("Deleted vanity subdomain successfully.");
        return;
      }

      yield* output.raw("Deleted vanity subdomain successfully.\n", "stderr");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
