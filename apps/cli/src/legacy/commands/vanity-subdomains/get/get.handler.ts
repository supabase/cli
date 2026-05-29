import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
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
  LegacyVanitySubdomainsGetNetworkError,
  LegacyVanitySubdomainsGetUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { LegacyVanitySubdomainsGetFlags } from "./get.command.ts";

const mapGetError = mapLegacyHttpError({
  networkError: LegacyVanitySubdomainsGetNetworkError,
  statusError: LegacyVanitySubdomainsGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected vanity subdomain status ${status}: ${body}`,
});

export const legacyVanitySubdomainsGet = Effect.fn("legacy.vanity-subdomains.get")(function* (
  flags: LegacyVanitySubdomainsGetFlags,
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
      const response = yield* api.v1
        .getVanitySubdomainConfig({ ref })
        .pipe(Effect.catch(mapGetError));
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
        yield* output.raw(
          encodeToml({
            Status: response.status,
            ...(response.custom_domain === undefined
              ? {}
              : { CustomDomain: response.custom_domain }),
          }) + "\n",
        );
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

      yield* output.raw(`Status: ${response.status}\n`);
      if (response.custom_domain !== undefined) {
        yield* output.raw(`Vanity subdomain: ${response.custom_domain}\n`);
      }
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
