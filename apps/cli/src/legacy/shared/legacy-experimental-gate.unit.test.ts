import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { LegacyExperimentalFlag } from "../../shared/legacy/global-flags.ts";
import {
  LegacyExperimentalRequiredError,
  legacyRequireExperimental,
} from "./legacy-experimental-gate.ts";

const ENV = "SUPABASE_EXPERIMENTAL";
const withFlag = (value: boolean, args: ReadonlyArray<string> = []) =>
  Layer.mergeAll(Layer.succeed(LegacyExperimentalFlag, value), Layer.succeed(CliArgs, { args }));

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

  it.effect(
    "fails even with SUPABASE_EXPERIMENTAL=1 when --experimental=false is explicit (viper Changed wins)",
    () =>
      Effect.gen(function* () {
        // viper's bound-pflag lookup returns the flag value whenever Changed is true —
        // BEFORE falling back to AutomaticEnv (viper@v1.21.0/viper.go:1176-1178) — so an
        // explicit --experimental=false must win over SUPABASE_EXPERIMENTAL=1.
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const error = yield* legacyRequireExperimental.pipe(
          Effect.provide(withFlag(false, ["--experimental=false"])),
          Effect.flip,
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(error).toBeInstanceOf(LegacyExperimentalRequiredError);
      }),
  );
});
