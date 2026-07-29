import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import {
  legacyGateResponse,
  legacySuggestUpgrade,
} from "../../../shared/legacy-upgrade-suggest.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyDesiredSubdomainRequiredError,
  LegacyVanitySubdomainsCheckNetworkError,
  LegacyVanitySubdomainsCheckUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { LegacyVanitySubdomainsCheckAvailabilityFlags } from "./check-availability.command.ts";

const mapCheckError = mapLegacyHttpError({
  networkError: LegacyVanitySubdomainsCheckNetworkError,
  statusError: LegacyVanitySubdomainsCheckUnexpectedStatusError,
  networkMessage: (cause) => `failed to check vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected check vanity subdomain status ${status}: ${body}`,
});

export const legacyVanitySubdomainsCheckAvailability = Effect.fn(
  "legacy.vanity-subdomains.check-availability",
)(function* (flags: LegacyVanitySubdomainsCheckAvailabilityFlags) {
  const output = yield* Output;
  const legacyOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      // Go validates the required `--desired-subdomain` only after
      // `PersistentPreRunE` completes (gate → login → ref resolution,
      // `cmd/root.go:93-117`; `cobra@v1.10.2/command.go:985,1005`), and
      // `PersistentPostRun` still fires telemetry + the linked-project cache
      // on that failure — hence this check sits inside both `Effect.ensuring`
      // wrappers, after ref resolution. Cobra checks the flag was *changed*,
      // not non-empty, so `--desired-subdomain ""` passes and reaches the API.
      if (Option.isNone(flags.desiredSubdomain)) {
        return yield* Effect.fail(
          new LegacyDesiredSubdomainRequiredError({
            message: `required flag(s) "desired-subdomain" not set`,
          }),
        );
      }
      const desiredSubdomain = flags.desiredSubdomain.value;
      const checking =
        output.format === "text"
          ? yield* output.task("Checking vanity subdomain availability...")
          : undefined;
      const response = yield* api.v1
        .checkVanitySubdomainAvailability({
          ref,
          vanity_subdomain: desiredSubdomain,
        })
        .pipe(
          Effect.tapError(() => checking?.fail() ?? Effect.void),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              // Flip the always-failing mapper into a success so we can inspect the
              // tagged error before deciding whether to suggest an upgrade, then re-fail.
              const mapped = yield* Effect.flip(mapCheckError(cause));
              if (mapped._tag === "LegacyVanitySubdomainsCheckUnexpectedStatusError") {
                // Go's check command calls SuggestUpgradeOnError without a following
                // TrackUpgradeSuggested, so suppress the analytics event for parity.
                yield* legacySuggestUpgrade({
                  projectRef: ref,
                  featureKey: "vanity_subdomain",
                  statusCode: mapped.status,
                  response: legacyGateResponse(cause),
                  trackAnalytics: false,
                });
              }
              return yield* Effect.fail(mapped);
            }),
          ),
        );
      yield* checking?.clear() ?? Effect.void;

      const legacyOutput = Option.getOrUndefined(legacyOutputFlag);

      if (legacyOutput === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (legacyOutput === "yaml") {
        yield* output.raw(encodeYaml(response));
        return;
      }
      if (legacyOutput === "toml") {
        yield* output.raw(encodeToml({ Available: response.available }) + "\n");
        return;
      }
      if (legacyOutput === "env") {
        yield* output.raw(encodeEnv(response) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(`Subdomain ${desiredSubdomain} available: ${response.available}\n`);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
