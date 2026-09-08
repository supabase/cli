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
  SslEnforcementMutuallyExclusiveFlagsError,
  SslEnforcementNoEnableDisableFlagError,
  SslEnforcementUpdateNetworkError,
  SslEnforcementUpdateUnexpectedStatusError,
} from "../ssl-enforcement.errors.ts";
import { printSslStatus } from "../ssl-enforcement.format.ts";
import type { SslEnforcementUpdateFlags } from "./update.command.ts";

// (Lowercase `ssl` in the network message is intentional.)
const mapUpdateError = mapHttpError({
  networkError: SslEnforcementUpdateNetworkError,
  statusError: SslEnforcementUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update ssl enforcement: ${cause}`,
  statusMessage: (status, body) => `unexpected update SSL status ${status}: ${body}`,
});

export const sslEnforcementUpdate = Effect.fn("ssl-enforcement.update")(function* (
  flags: SslEnforcementUpdateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Telemetry flushes on every invocation, including validation failures — matches Go's
  // PersistentPostRun semantics. The linked-project cache write happens only after the ref
  // has been resolved (it requires `ref` as input), so it wraps the inner sub-effect.
  yield* Effect.gen(function* () {
    if (flags.enableDbSslEnforcement && flags.disableDbSslEnforcement) {
      return yield* new SslEnforcementMutuallyExclusiveFlagsError();
    }
    if (!flags.enableDbSslEnforcement && !flags.disableDbSslEnforcement) {
      return yield* new SslEnforcementNoEnableDisableFlagError();
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

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(printSslStatus(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
