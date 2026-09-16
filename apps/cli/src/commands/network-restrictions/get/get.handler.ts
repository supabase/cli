import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/go-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  NetworkRestrictionsGetNetworkError,
  NetworkRestrictionsGetUnexpectedStatusError,
} from "../network-restrictions.errors.ts";
import { printNetworkRestrictionsStatus } from "../network-restrictions.format.ts";
import type { NetworkRestrictionsGetFlags } from "./get.command.ts";

// Note the *semicolon* in the status template — `; received: ` (vs the colon
// used in the update/patch templates).
const mapGetError = mapHttpError({
  networkError: NetworkRestrictionsGetNetworkError,
  statusError: NetworkRestrictionsGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve network restrictions: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve network restrictions; received: ${body}`,
});

export const networkRestrictionsGet = Effect.fn("network-restrictions.get")(function* (
  flags: NetworkRestrictionsGetFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text"
          ? yield* output.task("Fetching network restrictions...")
          : undefined;
      const response = yield* api.v1.getNetworkRestrictions({ ref }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(mapGetError),
      );
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(response));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(response) + "\n");
        return;
      }
      if (goFmt === "env") {
        yield* output.raw(encodeEnv(response) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(
        printNetworkRestrictionsStatus({
          v4: response.config.dbAllowedCidrs,
          v6: response.config.dbAllowedCidrsV6,
          applied: response.status === "applied",
        }),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
