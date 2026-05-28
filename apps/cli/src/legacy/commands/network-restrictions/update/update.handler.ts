import type {
  V1PatchNetworkRestrictionsOutput,
  V1UpdateNetworkRestrictionsOutput,
} from "@supabase/api/effect";
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
import { partitionPatchedCidrs, validateAndPartitionCidrs } from "../network-restrictions.cidr.ts";
import {
  LegacyNetworkRestrictionsInvalidCidrError,
  LegacyNetworkRestrictionsPrivateIpError,
  LegacyNetworkRestrictionsUpdateNetworkError,
  LegacyNetworkRestrictionsUpdateUnexpectedStatusError,
} from "../network-restrictions.errors.ts";
import { printNetworkRestrictionsStatus } from "../network-restrictions.format.ts";
import type { LegacyNetworkRestrictionsUpdateFlags } from "./update.command.ts";

// Templates lifted verbatim from `apps/cli-go/internal/restrictions/update/update.go:42,45,68,71`.
// Both POST `/apply` and PATCH `/network-restrictions` use the same Go message strings;
// we route through one mapper and discriminate downstream by the tagged error class.
const mapUpdateError = mapLegacyHttpError({
  networkError: LegacyNetworkRestrictionsUpdateNetworkError,
  statusError: LegacyNetworkRestrictionsUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to apply network restrictions: ${cause}`,
  statusMessage: (_status, body) => `failed to apply network restrictions: ${body}`,
});

export const legacyNetworkRestrictionsUpdate = Effect.fn("legacy.network-restrictions.update")(
  function* (flags: LegacyNetworkRestrictionsUpdateFlags) {
    const output = yield* Output;
    const goOutputFlag = yield* LegacyOutputFlag;
    const api = yield* LegacyPlatformApi;
    const resolver = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const telemetryState = yield* LegacyTelemetryState;

    yield* Effect.gen(function* () {
      // Go validates every input before any I/O (`update.go:20-33`). Run the same
      // pass first so a malformed CIDR short-circuits without resolving the ref
      // or writing the linked-project cache.
      const validation = validateAndPartitionCidrs(flags.dbAllowCidr, flags.bypassCidrChecks);
      if (!validation.ok) {
        if (validation.kind === "invalid") {
          return yield* new LegacyNetworkRestrictionsInvalidCidrError({ input: validation.input });
        }
        return yield* new LegacyNetworkRestrictionsPrivateIpError({ input: validation.input });
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
          // PATCH uses `&localSlice` in Go, which always renders as `&[]` / `&[...]`
          // even when no items match a given type. Partition returns concrete arrays
          // to match that always-non-nil semantic.
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
          // POST `/apply` prints the response field directly; if the API omits
          // either array it renders as `<nil>` (matches Go's `*[]string(nil)`).
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
  },
);
