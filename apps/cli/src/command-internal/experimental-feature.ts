import { Data, Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

export class ExperimentalFeatureFlagError extends Data.TaggedError("ExperimentalFeatureFlagError")<{
  readonly envName: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Resolves one experimental boolean from its environment override and config fallback. */
export const resolveExperimentalFeature = <E, R>(input: {
  readonly feature: string;
  readonly configValue: Effect.Effect<boolean | undefined, E, R>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean, E | ExperimentalFeatureFlagError, R> => {
  const envName = `SUPABASE_EXPERIMENTAL_${input.feature.toUpperCase()}`;
  const override = input.env[envName];
  if (override === undefined || override === "") {
    return input.configValue.pipe(Effect.map((value) => value === true));
  }
  if (override === "1") return Effect.succeed(true);
  if (override === "0") return Effect.succeed(false);
  return Effect.fail(
    new ExperimentalFeatureFlagError({
      envName,
      message: `${envName} must be 0 or 1 when set`,
    }),
  );
};
