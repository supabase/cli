import { isIP } from "node:net";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyNetworkBansInvalidIpError,
  LegacyNetworkBansRemoveNetworkError,
  LegacyNetworkBansRemoveUnexpectedStatusError,
} from "../network-bans.errors.ts";
import type { LegacyNetworkBansRemoveFlags } from "./remove.command.ts";

const mapRemoveError = mapLegacyHttpError({
  networkError: LegacyNetworkBansRemoveNetworkError,
  statusError: LegacyNetworkBansRemoveUnexpectedStatusError,
  networkMessage: (cause) => `failed to remove network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected unban status ${status}: ${body}`,
});

export const legacyNetworkBansRemove = Effect.fn("legacy.network-bans.remove")(function* (
  flags: LegacyNetworkBansRemoveFlags,
) {
  const output = yield* Output;
  const legacyOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    for (const ip of flags.dbUnbanIp) {
      if (isIP(ip) === 0) {
        return yield* new LegacyNetworkBansInvalidIpError({ input: ip });
      }
    }

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      yield* api.v1
        .deleteNetworkBans({
          ref,
          ipv4_addresses: [...flags.dbUnbanIp],
          requester_ip: flags.dbUnbanIp.length === 0,
        })
        .pipe(Effect.catch(mapRemoveError));

      // Go's `bansRemoveCmd.PostRun` always prints the success line to stdout
      // regardless of `--output` (`apps/cli-go/cmd/bans.go:28-30`). The TS-native
      // `--output-format json/stream-json` modes emit a structured success event
      // instead, but only when Go `--output` is unset (Go priority — CLAUDE.md item 6).
      if (
        Option.isNone(legacyOutputFlag) &&
        (output.format === "json" || output.format === "stream-json")
      ) {
        yield* output.success("Successfully removed network bans.");
        return;
      }

      yield* output.raw("Successfully removed network bans.\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
