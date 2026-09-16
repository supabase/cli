import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goPtr,
  goString,
  goStruct,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import {
  VanitySubdomainsGetNetworkError,
  VanitySubdomainsGetUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { VanitySubdomainsGetFlags } from "./get.command.ts";

/** Type shape for `api.VanitySubdomainConfigResponse` (`types.gen.go`). */
const GO_VANITY_CONFIG_RESPONSE = goStruct([
  ["custom_domain", goPtr(goString)],
  ["status", goString],
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
      yield* fetching?.clear() ?? Effect.void;

      const goOutput = Option.getOrUndefined(outputFlag);

      if (goOutput === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (goOutput === "yaml") {
        yield* output.raw(encodeGoYaml(response, GO_VANITY_CONFIG_RESPONSE));
        return;
      }
      if (goOutput === "toml") {
        yield* output.raw(encodeGoToml(response, GO_VANITY_CONFIG_RESPONSE));
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

      yield* output.raw(`Status: ${response.status}\n`);
      if (response.custom_domain !== undefined) {
        yield* output.raw(`Vanity subdomain: ${response.custom_domain}\n`);
      }
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
