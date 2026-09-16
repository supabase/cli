import type {
  V1PatchNetworkRestrictionsOutput,
  V1UpdateNetworkRestrictionsOutput,
} from "@supabase/api/effect";
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
import { partitionPatchedCidrs, validateAndPartitionCidrs } from "../network-restrictions.cidr.ts";
import {
  NetworkRestrictionsInvalidCidrError,
  NetworkRestrictionsPrivateIpError,
  NetworkRestrictionsUpdateNetworkError,
  NetworkRestrictionsUpdateUnexpectedStatusError,
} from "../network-restrictions.errors.ts";
import { printNetworkRestrictionsStatus } from "../network-restrictions.format.ts";
import type { NetworkRestrictionsUpdateFlags } from "./update.command.ts";

// Both POST `/apply` and PATCH `/network-restrictions` use the same message
// strings; we route through one mapper and discriminate downstream by the
// tagged error class.
const mapUpdateError = mapHttpError({
  networkError: NetworkRestrictionsUpdateNetworkError,
  statusError: NetworkRestrictionsUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to apply network restrictions: ${cause}`,
  statusMessage: (_status, body) => `failed to apply network restrictions: ${body}`,
});

export const networkRestrictionsUpdate = Effect.fn("network-restrictions.update")(function* (
  flags: NetworkRestrictionsUpdateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    // Validate every input before any I/O, so a malformed CIDR short-circuits without
    // resolving the ref or writing the linked-project cache.
    const validation = validateAndPartitionCidrs(flags.dbAllowCidr, flags.bypassCidrChecks);
    if (!validation.ok) {
      if (validation.kind === "invalid") {
        return yield* new NetworkRestrictionsInvalidCidrError({ input: validation.input });
      }
      return yield* new NetworkRestrictionsPrivateIpError({ input: validation.input });
    }
    const { v4, v6 } = validation;

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const updating =
        output.format === "text"
          ? yield* output.task("Updating network restrictions...")
          : undefined;

      let v4Out: readonly string[] | undefined;
      let v6Out: readonly string[] | undefined;
      let applied: boolean;
      let envelope:
        | typeof V1UpdateNetworkRestrictionsOutput.Type
        | typeof V1PatchNetworkRestrictionsOutput.Type;

      if (flags.append) {
        const response = yield* api.v1
          .patchNetworkRestrictions({
            ref,
            add: { dbAllowedCidrs: v4, dbAllowedCidrsV6: v6 },
          })
          .pipe(
            Effect.tapError(() => updating?.fail() ?? Effect.void),
            Effect.catch(mapUpdateError),
          );
        yield* updating?.clear() ?? Effect.void;
        // The PATCH response always renders as `&[]`/`&[...]`, never `<nil>`; partition
        // returns concrete arrays to match, even when a type has no items.
        const partitioned = partitionPatchedCidrs(response.config.dbAllowedCidrs);
        v4Out = partitioned.v4;
        v6Out = partitioned.v6;
        applied = response.status === "applied";
        envelope = response;
      } else {
        const response = yield* api.v1
          .updateNetworkRestrictions({
            ref,
            dbAllowedCidrs: v4,
            dbAllowedCidrsV6: v6,
          })
          .pipe(
            Effect.tapError(() => updating?.fail() ?? Effect.void),
            Effect.catch(mapUpdateError),
          );
        yield* updating?.clear() ?? Effect.void;
        // POST /apply prints the response field directly; an omitted array renders as `<nil>`.
        v4Out = response.config.dbAllowedCidrs;
        v6Out = response.config.dbAllowedCidrsV6;
        applied = response.status === "applied";
        envelope = response;
      }

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(envelope));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(envelope));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(envelope) + "\n");
        return;
      }
      if (goFmt === "env") {
        yield* output.raw(encodeEnv(envelope) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", envelope);
        return;
      }

      yield* output.raw(printNetworkRestrictionsStatus({ v4: v4Out, v6: v6Out, applied }));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
