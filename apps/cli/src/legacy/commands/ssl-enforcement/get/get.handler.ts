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
  LegacySslEnforcementGetNetworkError,
  LegacySslEnforcementGetUnexpectedStatusError,
} from "../ssl-enforcement.errors.ts";
import { printSslStatus } from "../ssl-enforcement.format.ts";
import type { LegacySslEnforcementGetFlags } from "./get.command.ts";

// Templates lifted verbatim from `apps/cli-go/internal/ssl_enforcement/get/get.go:17,19`.
const mapGetError = mapLegacyHttpError({
  networkError: LegacySslEnforcementGetNetworkError,
  statusError: LegacySslEnforcementGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve SSL enforcement config: ${cause}`,
  statusMessage: (status, body) => `unexpected SSL enforcement status ${status}: ${body}`,
});

export const legacySslEnforcementGet = Effect.fn("legacy.ssl-enforcement.get")(function* (
  flags: LegacySslEnforcementGetFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Mirror Go's PersistentPostRun (`apps/cli-go/cmd/root.go:176`): telemetry must flush
  // whether ref resolution, the API call, or output emission fails. `linkedProjectCache.cache`
  // requires a resolved ref, so it wraps the inner sub-effect only.
  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text"
          ? yield* output.task("Fetching SSL enforcement config...")
          : undefined;
      const response = yield* api.v1.getSslEnforcementConfig({ ref }).pipe(
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

      // goFmt is undefined or "pretty" — defer to TS --output-format for JSON/stream-json,
      // otherwise print the Go text-mode status line (Go --output pretty parity).
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(printSslStatus(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
