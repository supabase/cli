import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { GO_SSL_ENFORCEMENT_RESPONSE } from "../ssl-enforcement.go-payload.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  SslEnforcementGetNetworkError,
  SslEnforcementGetUnexpectedStatusError,
} from "../ssl-enforcement.errors.ts";
import { printSslStatus } from "../ssl-enforcement.format.ts";
import type { SslEnforcementGetFlags } from "./get.command.ts";

const mapGetError = mapHttpError({
  networkError: SslEnforcementGetNetworkError,
  statusError: SslEnforcementGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve SSL enforcement config: ${cause}`,
  statusMessage: (status, body) => `unexpected SSL enforcement status ${status}: ${body}`,
});

export const sslEnforcementGet = Effect.fn("ssl-enforcement.get")(function* (
  flags: SslEnforcementGetFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Telemetry must flush whether ref resolution, the API call, or output
  // emission fails. `linkedProjectCache.cache` requires a resolved ref, so
  // it wraps the inner sub-effect only.
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
        yield* output.raw(encodeGoYaml(response, GO_SSL_ENFORCEMENT_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeGoToml(response, GO_SSL_ENFORCEMENT_RESPONSE));
        return;
      }
      if (goFmt === "env") {
        yield* output.raw(encodeEnv(response) + "\n");
        return;
      }

      // goFmt is undefined or "pretty" — defer to TS --output-format for JSON/stream-json,
      // otherwise print the text-mode status line.
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(printSslStatus(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
