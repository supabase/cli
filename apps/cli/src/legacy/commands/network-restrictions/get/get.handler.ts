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
  LegacyNetworkRestrictionsGetNetworkError,
  LegacyNetworkRestrictionsGetUnexpectedStatusError,
} from "../network-restrictions.errors.ts";
import { printNetworkRestrictionsStatus } from "../network-restrictions.format.ts";
import type { LegacyNetworkRestrictionsGetFlags } from "./get.command.ts";

// Templates lifted verbatim from `apps/cli-go/internal/restrictions/get/get.go:15,18`.
// Note the *semicolon* in the status template — Go uses `; received: ` (vs the colon
// used in the update/patch templates).
const mapGetError = mapLegacyHttpError({
  networkError: LegacyNetworkRestrictionsGetNetworkError,
  statusError: LegacyNetworkRestrictionsGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve network restrictions: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve network restrictions; received: ${body}`,
});

export const legacyNetworkRestrictionsGet = Effect.fn("legacy.network-restrictions.get")(function* (
  flags: LegacyNetworkRestrictionsGetFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

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
