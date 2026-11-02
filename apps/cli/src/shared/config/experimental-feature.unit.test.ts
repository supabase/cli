import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import {
  ExperimentalFeatureFlagError,
  resolveExperimentalFeature,
} from "./experimental-feature.ts";

const resolveStack = (value: string) =>
  withConfigEnv(
    { SUPABASE_EXPERIMENTAL_STACK: value },
    resolveExperimentalFeature({ feature: "stack", configValue: Effect.undefined }),
  ).pipe(Effect.provide(Path.layer));

describe("resolveExperimentalFeature boolean spellings", () => {
  it.effect.each(["1", "t", "T", "TRUE", "true", "True"])("enables on %s", (value) =>
    Effect.gen(function* () {
      expect(yield* resolveStack(value)).toBe(true);
    }),
  );

  it.effect.each(["tRuE", "tRue", "yes"])("rejects %s", (value) =>
    Effect.gen(function* () {
      const error = yield* resolveStack(value).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      expect(error.envName).toBe("SUPABASE_EXPERIMENTAL_STACK");
    }),
  );
});
