import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapePtr,
  shapeString,
  shapeStruct,
} from "../../../command-internal/struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import {
  VanitySubdomainsGetNetworkError,
  VanitySubdomainsGetUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { VanitySubdomainsGetFlags } from "./get.command.ts";

/** Type shape for the vanity subdomain config response. */
const VANITY_CONFIG_RESPONSE_SHAPE = shapeStruct([
  ["custom_domain", shapePtr(shapeString)],
  ["status", shapeString],
]);

const mapGetError = mapHttpError({
  networkError: VanitySubdomainsGetNetworkError,
  statusError: VanitySubdomainsGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected vanity subdomain status ${status}: ${body}`,
});

export const vanitySubdomainsGet = Effect.fn("vanity-subdomains.get")(function* (
  flags: VanitySubdomainsGetFlags,
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
      const fetching =
        output.format === "text" ? yield* output.task("Getting vanity subdomain...") : undefined;
      const response = yield* api.v1.getVanitySubdomainConfig({ ref }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(gateMapError({ projectRef: ref }, mapGetError)),
      );
      yield* fetching?.clear ?? Effect.void;

      const outputFlagFormat = Option.getOrUndefined(outputFlag);

      if (outputFlagFormat === "json") {
        yield* output.raw(encodeSortedJson(response));
        return;
      }
      if (outputFlagFormat === "yaml") {
        yield* output.raw(encodeStructYaml(response, VANITY_CONFIG_RESPONSE_SHAPE));
        return;
      }
      if (outputFlagFormat === "toml") {
        yield* output.raw(encodeStructToml(response, VANITY_CONFIG_RESPONSE_SHAPE));
        return;
      }
      if (outputFlagFormat === "env") {
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
