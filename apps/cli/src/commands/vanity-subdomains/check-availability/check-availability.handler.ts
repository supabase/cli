import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goBool,
  goStruct,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  DesiredSubdomainRequiredError,
  VanitySubdomainsCheckNetworkError,
  VanitySubdomainsCheckUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { VanitySubdomainsCheckAvailabilityFlags } from "./check-availability.command.ts";

/** Struct shape for encoding the availability response as YAML/TOML. */
const GO_AVAILABILITY_RESPONSE = goStruct([["available", goBool]]);

const mapCheckError = mapHttpError({
  networkError: VanitySubdomainsCheckNetworkError,
  statusError: VanitySubdomainsCheckUnexpectedStatusError,
  networkMessage: (cause) => `failed to check vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected check vanity subdomain status ${status}: ${body}`,
});

export const vanitySubdomainsCheckAvailability = Effect.fn("vanity-subdomains.check-availability")(
  function* (flags: VanitySubdomainsCheckAvailabilityFlags) {
    const output = yield* Output;
    const outputFlag = yield* OutputFlag;
    const api = yield* CommandPlatformApi;
    const resolver = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const telemetryState = yield* TelemetryState;

    yield* Effect.gen(function* () {
      const ref = yield* resolver.resolve(flags.projectRef);

      yield* Effect.gen(function* () {
        // This check sits inside both `Effect.ensuring` wrappers so telemetry and the
        // linked-project cache still fire on this failure. Only absence is checked, not
        // emptiness, so an explicit `--desired-subdomain ""` passes through to the API.
        if (Option.isNone(flags.desiredSubdomain)) {
          return yield* Effect.fail(
            new DesiredSubdomainRequiredError({
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
                if (mapped._tag === "VanitySubdomainsCheckUnexpectedStatusError") {
                  // Unlike `activate`, this command suppresses the upgrade-suggestion
                  // analytics event.
                  const upgradeSuggested = yield* suggestUpgrade({
                    projectRef: ref,
                    featureKey: "vanity_subdomain",
                    statusCode: mapped.status,
                    response: gateResponse(cause),
                    trackAnalytics: false,
                  });
                  return yield* Effect.fail(
                    new VanitySubdomainsCheckUnexpectedStatusError({
                      status: mapped.status,
                      body: mapped.body,
                      message: mapped.message,
                      upgradeSuggested,
                    }),
                  );
                }
                return yield* Effect.fail(mapped);
              }),
            ),
          );
        yield* checking?.clear() ?? Effect.void;

        const goOutput = Option.getOrUndefined(outputFlag);

        if (goOutput === "json") {
          yield* output.raw(encodeGoJson(response));
          return;
        }
        if (goOutput === "yaml") {
          yield* output.raw(encodeGoYaml(response, GO_AVAILABILITY_RESPONSE));
          return;
        }
        if (goOutput === "toml") {
          yield* output.raw(encodeGoToml(response, GO_AVAILABILITY_RESPONSE));
          return;
        }
        if (goOutput === "env") {
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
  },
);
