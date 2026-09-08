import { Effect } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
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
      const deleting =
        output.format === "text" ? yield* output.task("Deleting Postgres config...") : undefined;
      const currentConfig = yield* fetchCurrentPostgresConfig(ref).pipe(
        Effect.tapError(() => deleting?.fail() ?? Effect.void),
      );

      for (const key of flags.config) {
        delete currentConfig[key.trim()];
      }

      if (flags.noRestart) {
        currentConfig["restart_database"] = false;
      }

      const updated = yield* putPostgresConfig(ref, currentConfig, {
        serializeError: (args) => new PostgresConfigDeleteSerializeError(args),
        networkError: (args) => new PostgresConfigDeleteNetworkError(args),
        statusError: (args) => new PostgresConfigDeleteUnexpectedStatusError(args),
        unmarshalError: (args) => new PostgresConfigDeleteUnmarshalError(args),
        networkMessage: (description) => `failed to delete config overrides: ${description}`,
        statusMessage: (status, body) =>
          `unexpected delete config overrides status ${status}: ${body}`,
        unmarshalMessage: (description) => `failed to unmarshal delete response: ${description}`,
      }).pipe(Effect.tapError(() => deleting?.fail() ?? Effect.void));

      yield* deleting?.clear() ?? Effect.void;
      yield* writePostgresConfigOutput(updated);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
