import { Effect } from "effect";

import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPostgresConfigInvalidConfigValueError } from "../postgres-config.errors.ts";
import {
  fetchCurrentPostgresConfig,
  normalizeTimeoutConfig,
  parseConfigValue,
  putPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { LegacyPostgresConfigUpdateFlags } from "./update.command.ts";

export const legacyPostgresConfigUpdate = Effect.fn("legacy.postgres-config.update")(function* (
  flags: LegacyPostgresConfigUpdateFlags,
) {
  const output = yield* Output;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const nextOverrides: Record<string, string> = {};
    for (const config of flags.config) {
      const splits = config.split("=");
      if (splits.length !== 2) {
        return yield* new LegacyPostgresConfigInvalidConfigValueError({ input: config });
      }
      nextOverrides[splits[0] ?? ""] = splits[1] ?? "";
    }

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const updating =
        output.format === "text" ? yield* output.task("Updating Postgres config...") : undefined;

      const finalOverrides = flags.replaceExistingOverrides
        ? {}
        : yield* fetchCurrentPostgresConfig(ref).pipe(
            Effect.tapError(() => updating?.fail() ?? Effect.void),
          );

      for (const [key, value] of Object.entries(nextOverrides)) {
        finalOverrides[key] = parseConfigValue(value);
      }

      if (flags.noRestart) {
        finalOverrides["restart_database"] = false;
      }

      normalizeTimeoutConfig(finalOverrides);

      const updated = yield* putPostgresConfig(ref, finalOverrides, "update").pipe(
        Effect.tapError(() => updating?.fail() ?? Effect.void),
      );

      yield* updating?.clear() ?? Effect.void;
      yield* writePostgresConfigOutput(updated);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
