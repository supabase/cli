import { isIP } from "node:net";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  NetworkBansInvalidIpError,
  NetworkBansRemoveNetworkError,
  NetworkBansRemoveUnexpectedStatusError,
} from "../network-bans.errors.ts";
import type { NetworkBansRemoveFlags } from "./remove.command.ts";

const mapRemoveError = mapHttpError({
  networkError: NetworkBansRemoveNetworkError,
  statusError: NetworkBansRemoveUnexpectedStatusError,
  networkMessage: (cause) => `failed to remove network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected unban status ${status}: ${body}`,
});

export const networkBansRemove = Effect.fn("network-bans.remove")(function* (
  flags: NetworkBansRemoveFlags,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    // Resolves before validating --db-unban-ip, so a bad ref surfaces before a bad IP.
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      for (const ip of flags.dbUnbanIp) {
        if (isIP(ip) === 0) {
          return yield* new NetworkBansInvalidIpError({ input: ip });
        }
      }

      yield* api.v1
        .deleteNetworkBans({
          ref,
          ipv4_addresses: [...flags.dbUnbanIp],
          requester_ip: flags.dbUnbanIp.length === 0,
        })
        .pipe(Effect.catch(mapRemoveError));

      // Always prints to stdout regardless of --output; --output-format json/stream-json
      // emit a structured event instead, but only when --output is unset.
      if (
        Option.isNone(outputFlag) &&
        (output.format === "json" || output.format === "stream-json")
      ) {
        yield* output.success("Successfully removed network bans.");
        return;
      }

      yield* output.raw("Successfully removed network bans.\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
