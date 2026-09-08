import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson, encodeYaml } from "../../../command-internal/go-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { encodeBannedIpsToml } from "../network-bans.encoders.ts";
import {
  NetworkBansEnvNotSupportedError,
  NetworkBansGetNetworkError,
  NetworkBansGetUnexpectedStatusError,
} from "../network-bans.errors.ts";
import type { NetworkBansGetFlags } from "./get.command.ts";

const mapGetError = mapHttpError({
  networkError: NetworkBansGetNetworkError,
  statusError: NetworkBansGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to list network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected list bans status ${status}: ${body}`,
});

export const networkBansGet = Effect.fn("network-bans.get")(function* (flags: NetworkBansGetFlags) {
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
        output.format === "text" ? yield* output.task("Fetching network bans...") : undefined;
      const response = yield* api.v1.listAllNetworkBans({ ref }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(mapGetError),
      );
      yield* fetching?.clear() ?? Effect.void;

      const goOutput = Option.getOrUndefined(outputFlag);

      // TS-native machine-readable modes skip the stderr heading for clean output.
      // Go --output takes priority (CLAUDE.md item 6), so this only fires when the
      // legacy flag is unset.
      if (goOutput === undefined && (output.format === "json" || output.format === "stream-json")) {
        yield* output.success("", response);
        return;
      }

      // Prints `DB banned IPs:` to stderr unconditionally before the format
      // switch, including for `--output env` (which then errors).
      yield* output.raw("DB banned IPs:\n", "stderr");

      if (goOutput === "env") {
        return yield* new NetworkBansEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }
      if (goOutput === "yaml") {
        yield* output.raw(encodeYaml(response.banned_ipv4_addresses));
        return;
      }
      if (goOutput === "toml") {
        yield* output.raw(encodeBannedIpsToml(response.banned_ipv4_addresses));
        return;
      }

      // Default and `--output {json,pretty}`. Go aliases `pretty` → `json` in
      // `get.go:21-23` and falls through to `EncodeOutput(format, ips)`.
      yield* output.raw(encodeGoJson(response.banned_ipv4_addresses));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
