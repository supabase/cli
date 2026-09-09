import { Effect } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  PostgresConfigInvalidConfigValueError,
  PostgresConfigUpdateNetworkError,
  PostgresConfigUpdateSerializeError,
  PostgresConfigUpdateUnexpectedStatusError,
  PostgresConfigUpdateUnmarshalError,
} from "../postgres-config.errors.ts";
import {
  fetchCurrentPostgresConfig,
  normalizeTimeoutConfig,
  parseConfigValue,
  putPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { PostgresConfigUpdateFlags } from "./update.command.ts";

export const postgresConfigUpdate = Effect.fn("postgres-config.update")(function* (
  flags: PostgresConfigUpdateFlags,
) {
  const output = yield* Output;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const nextOverrides: Record<string, string> = {};
    for (const config of flags.config) {
      const splits = config.split("=");
      if (splits.length !== 2) {
        return yield* new PostgresConfigInvalidConfigValueError({ input: config });
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

      const updated = yield* putPostgresConfig(ref, finalOverrides, {
        serializeError: (args) => new PostgresConfigUpdateSerializeError(args),
        networkError: (args) => new PostgresConfigUpdateNetworkError(args),
        statusError: (args) => new PostgresConfigUpdateUnexpectedStatusError(args),
        unmarshalError: (args) => new PostgresConfigUpdateUnmarshalError(args),
        networkMessage: (description) => `failed to update config overrides: ${description}`,
        statusMessage: (status, body) =>
          `unexpected update config overrides status ${status}: ${body}`,
        unmarshalMessage: (description) => `failed to unmarshal update response: ${description}`,
      }).pipe(Effect.tapError(() => updating?.fail() ?? Effect.void));

      yield* updating?.clear() ?? Effect.void;
      yield* writePostgresConfigOutput(updated);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
