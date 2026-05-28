import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyNetworkBansEnvNotSupportedError,
  LegacyNetworkBansGetNetworkError,
  LegacyNetworkBansGetUnexpectedStatusError,
} from "../network-bans.errors.ts";
import type { LegacyNetworkBansGetFlags } from "./get.command.ts";

const mapGetError = mapLegacyHttpError({
  networkError: LegacyNetworkBansGetNetworkError,
  statusError: LegacyNetworkBansGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to list network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected list bans status ${status}: ${body}`,
});

function encodeBannedIpsToml(ips: ReadonlyArray<string>): string {
  return `banned_ips = [${ips.map((ip) => JSON.stringify(ip)).join(", ")}]\n`;
}

export const legacyNetworkBansGet = Effect.fn("legacy.network-bans.get")(function* (
  flags: LegacyNetworkBansGetFlags,
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
      const response = yield* api.v1.listAllNetworkBans({ ref }).pipe(Effect.catch(mapGetError));

      const legacyOutput = Option.getOrUndefined(legacyOutputFlag);

      if (
        legacyOutput === undefined &&
        (output.format === "json" || output.format === "stream-json")
      ) {
        yield* output.success("", response);
        return;
      }

      yield* output.raw("DB banned IPs:\n", "stderr");

      if (legacyOutput === "env") {
        return yield* new LegacyNetworkBansEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }
      if (legacyOutput === "yaml") {
        yield* output.raw(encodeYaml(response.banned_ipv4_addresses));
        return;
      }
      if (legacyOutput === "toml") {
        yield* output.raw(encodeBannedIpsToml(response.banned_ipv4_addresses));
        return;
      }

      yield* output.raw(encodeGoJson(response.banned_ipv4_addresses));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
