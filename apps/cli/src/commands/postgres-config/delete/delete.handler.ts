import { Effect } from "effect";

import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { OutputTask } from "../../../shared/output/output.service.ts";
import {
  PostgresConfigDeleteNetworkError,
  PostgresConfigDeleteSerializeError,
  PostgresConfigDeleteUnexpectedStatusError,
  PostgresConfigDeleteUnmarshalError,
} from "../postgres-config.errors.ts";
import {
  fetchCurrentPostgresConfig,
  putPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { PostgresConfigDeleteFlags } from "./delete.command.ts";

export const postgresConfigDelete = Effect.fn("postgres-config.delete")(function* (
  flags: PostgresConfigDeleteFlags,
) {
  const output = yield* Output;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const startTask = Effect.suspend((): Effect.Effect<OutputTask | undefined> =>
        output.format === "text" ? output.task("Deleting Postgres config...") : Effect.undefined,
      );

      const fetching = yield* startTask;
      const currentConfig = yield* fetchCurrentPostgresConfig(ref).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      yield* fetching?.clear ?? Effect.void;

      const keys = flags.config.map((key) => key.trim());
      for (const key of keys) {
        delete currentConfig[key];
      }

      if (flags.noRestart) {
        currentConfig["restart_database"] = false;
      }

      yield* requireHostedMutationConsent({
        action: "Delete Postgres config overrides",
        details: [
          ...keys.map((key) => `Delete ${key}`),
          ...(flags.noRestart ? ["Does not restart the database"] : []),
        ],
      });

      const deleting = yield* startTask;
      const updated = yield* putPostgresConfig(ref, currentConfig, {
        serializeError: (args) => new PostgresConfigDeleteSerializeError(args),
        networkError: (args) => new PostgresConfigDeleteNetworkError(args),
        statusError: (args) => new PostgresConfigDeleteUnexpectedStatusError(args),
        parseError: (args) => new PostgresConfigDeleteUnmarshalError(args),
        networkMessage: (description) => `failed to delete config overrides: ${description}`,
        statusMessage: (status, body) =>
          `unexpected delete config overrides status ${status}: ${body}`,
        parseMessage: (description) => `failed to parse delete response: ${description}`,
      }).pipe(Effect.tapError(() => deleting?.fail() ?? Effect.void));

      yield* deleting?.clear ?? Effect.void;
      yield* writePostgresConfigOutput(updated);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
