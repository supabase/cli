import { Effect, Option } from "effect";

import type {
  CliConfigFlagConflictError,
  CliConfigValueError,
} from "../config/cli-config.errors.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { describeConfigSnapshotFailure } from "./config-snapshot-context.ts";

type ConfigValueFailure = CliConfigValueError | CliConfigFlagConflictError;

/** A config failure that names the offending value or flag, and so reaches the user unwrapped. */
export const isConfigValueFailure = (cause: unknown): cause is ConfigValueFailure =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "CliConfigValueError" || cause._tag === "CliConfigFlagConflictError");

/**
 * Loads the snapshot ahead of helpers that fold every load failure into one message, so an
 * invalid value or flag conflict surfaces as-is and only other failures take `toError`. The load
 * is memoised, so the helper that follows reuses it.
 */
export const loadSnapshotSurfacingValueErrors = <E>(
  workdir: string,
  toError: (message: string) => E,
  projectRef: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const values = yield* CliConfigValues;
    return yield* values
      .load({ workdir, projectRef })
      .pipe(
        Effect.mapError((cause) =>
          isConfigValueFailure(cause) ? cause : toError(describeConfigSnapshotFailure(cause)),
        ),
      );
  });

/** Fails with an invalid value or flag conflict, and ignores every other load failure. */
export const failOnInvalidConfigValue = (
  workdir: string,
  projectRef: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const values = yield* CliConfigValues;
    yield* values
      .load({ workdir, projectRef })
      .pipe(
        Effect.catch((cause) => (isConfigValueFailure(cause) ? Effect.fail(cause) : Effect.void)),
      );
  });
