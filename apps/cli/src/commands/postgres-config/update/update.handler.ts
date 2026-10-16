import { Effect } from "effect";

import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { OutputTask } from "../../../shared/output/output.service.ts";
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
      const startTask = Effect.suspend((): Effect.Effect<OutputTask | undefined> =>
        output.format === "text" ? output.task("Updating Postgres config...") : Effect.undefined,
      );

      const fetching = flags.replaceExistingOverrides ? undefined : yield* startTask;
      const preserved = flags.replaceExistingOverrides
        ? {}
        : yield* fetchCurrentPostgresConfig(ref).pipe(
            Effect.tapError(() => fetching?.fail() ?? Effect.void),
          );
      yield* fetching?.clear ?? Effect.void;

      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(nextOverrides)) {
        changes[key] = parseConfigValue(value);
      }

      if (flags.noRestart) {
        changes["restart_database"] = false;
      }

      normalizeTimeoutConfig(changes);
      normalizeTimeoutConfig(preserved);

      yield* requireHostedMutationConsent({
        action: "Update the Postgres config overrides",
        details: [
          ...(flags.replaceExistingOverrides ? ["Replaces all existing overrides"] : []),
          ...Object.entries(nextOverrides).map(([key, value]) => `Set ${key} = ${value}`),
          ...(flags.noRestart ? ["Does not restart the database"] : []),
        ],
      });

      const updating = yield* startTask;
      const updated = yield* putPostgresConfig(
        ref,
        { changes, preserved },
        {
          serializeError: (args) => new PostgresConfigUpdateSerializeError(args),
          networkError: PostgresConfigUpdateNetworkError,
          statusError: PostgresConfigUpdateUnexpectedStatusError,
          parseError: (args) => new PostgresConfigUpdateUnmarshalError(args),
          networkMessage: (description) => `failed to update config overrides: ${description}`,
          statusMessage: (status, body) =>
            `unexpected update config overrides status ${status}: ${body}`,
          parseMessage: (description) => `failed to parse update response: ${description}`,
        },
      ).pipe(Effect.tapError(() => updating?.fail() ?? Effect.void));

      yield* updating?.clear ?? Effect.void;
      yield* writePostgresConfigOutput(updated);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
