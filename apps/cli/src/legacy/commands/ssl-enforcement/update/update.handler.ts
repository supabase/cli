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
  LegacySslEnforcementMutuallyExclusiveFlagsError,
  LegacySslEnforcementNoEnableDisableFlagError,
  LegacySslEnforcementUpdateNetworkError,
  LegacySslEnforcementUpdateUnexpectedStatusError,
} from "../ssl-enforcement.errors.ts";
import { printSslStatus } from "../ssl-enforcement.format.ts";
import type { LegacySslEnforcementUpdateFlags } from "./update.command.ts";

// Templates lifted verbatim from `apps/cli-go/internal/ssl_enforcement/update/update.go:19,21`.
// (Lowercase `ssl` in the network message is intentional Go fidelity.)
const mapUpdateError = mapLegacyHttpError({
  networkError: LegacySslEnforcementUpdateNetworkError,
  statusError: LegacySslEnforcementUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update ssl enforcement: ${cause}`,
  statusMessage: (status, body) => `unexpected update SSL status ${status}: ${body}`,
});

export const legacySslEnforcementUpdate = Effect.fn("legacy.ssl-enforcement.update")(function* (
  flags: LegacySslEnforcementUpdateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Telemetry flushes on every invocation, including validation failures — matches Go's
  // PersistentPostRun semantics. The linked-project cache write happens only after the ref
  // has been resolved (it requires `ref` as input), so it wraps the inner sub-effect.
  yield* Effect.gen(function* () {
    if (flags.enableDbSslEnforcement && flags.disableDbSslEnforcement) {
      return yield* new LegacySslEnforcementMutuallyExclusiveFlagsError();
    }
    if (!flags.enableDbSslEnforcement && !flags.disableDbSslEnforcement) {
      return yield* new LegacySslEnforcementNoEnableDisableFlagError();
    }

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const updating =
        output.format === "text"
          ? yield* output.task("Updating SSL enforcement config...")
          : undefined;
      // Go only sends the `enforceDbSsl` boolean (`update.go:16`); `--disable-db-ssl-enforcement`
      // is the user-facing way to send `database: false`.
      const response = yield* api.v1
        .updateSslEnforcementConfig({
          ref,
          requestedConfig: { database: flags.enableDbSslEnforcement },
        })
        .pipe(
          Effect.tapError(() => updating?.fail() ?? Effect.void),
          Effect.catch(mapUpdateError),
        );
      yield* updating?.clear() ?? Effect.void;

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

      yield* output.raw(printSslStatus(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
