import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { LegacyExperimentalFlag } from "../../shared/legacy/global-flags.ts";
import {
  LegacyExperimentalRequiredError,
  legacyRequireExperimental,
} from "./legacy-experimental-gate.ts";

const ENV = "SUPABASE_EXPERIMENTAL";
const withFlag = (value: boolean) => Layer.succeed(LegacyExperimentalFlag, value);

describe("legacyRequireExperimental", () => {
  it.effect("passes when --experimental is set", () =>
    legacyRequireExperimental.pipe(Effect.provide(withFlag(true))),
  );

  it.effect("fails with Go's byte-exact message when neither flag nor env is set", () =>
    Effect.gen(function* () {
      const saved = process.env[ENV];
      delete process.env[ENV];
      const error = yield* legacyRequireExperimental.pipe(
        Effect.provide(withFlag(false)),
        Effect.flip,
      );
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
      expect(error).toBeInstanceOf(LegacyExperimentalRequiredError);
      expect(error.message).toBe("must set the --experimental flag to run this command");
    }),
  );

  it.effect("passes when SUPABASE_EXPERIMENTAL=1 even without the flag (viper AutomaticEnv)", () =>
    Effect.gen(function* () {
      const saved = process.env[ENV];
      process.env[ENV] = "1";
      const exit = yield* legacyRequireExperimental.pipe(
        Effect.provide(withFlag(false)),
        Effect.exit,
      );
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
      expect(exit._tag).toBe("Success");
    }),
  );
});
