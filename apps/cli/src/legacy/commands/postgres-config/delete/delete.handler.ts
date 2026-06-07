import { Effect } from "effect";

import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  LegacyPostgresConfigDeleteNetworkError,
  LegacyPostgresConfigDeleteSerializeError,
  LegacyPostgresConfigDeleteUnexpectedStatusError,
  LegacyPostgresConfigDeleteUnmarshalError,
} from "../postgres-config.errors.ts";
import {
  fetchCurrentPostgresConfig,
  putPostgresConfig,
  writePostgresConfigOutput,
} from "../postgres-config.shared.ts";
import type { LegacyPostgresConfigDeleteFlags } from "./delete.command.ts";

export const legacyPostgresConfigDelete = Effect.fn("legacy.postgres-config.delete")(function* (
  flags: LegacyPostgresConfigDeleteFlags,
) {
  const output = yield* Output;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

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
        serializeError: (args) => new LegacyPostgresConfigDeleteSerializeError(args),
        networkError: (args) => new LegacyPostgresConfigDeleteNetworkError(args),
        statusError: (args) => new LegacyPostgresConfigDeleteUnexpectedStatusError(args),
        unmarshalError: (args) => new LegacyPostgresConfigDeleteUnmarshalError(args),
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
