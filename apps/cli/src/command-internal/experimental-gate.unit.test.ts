import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { ExperimentalFlag } from "./global-flags.ts";
import { ExperimentalRequiredError, requireExperimental } from "./experimental-gate.ts";

const ENV = "SUPABASE_EXPERIMENTAL";
const withFlag = (value: boolean, args: ReadonlyArray<string> = []) =>
  Layer.mergeAll(Layer.succeed(ExperimentalFlag, value), Layer.succeed(CliArgs, { args }));
const withShellEnv = (env: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }));

describe("requireExperimental", () => {
  it.effect("passes when --experimental is set", () =>
    requireExperimental.pipe(Effect.provide(withFlag(true))),
  );

  it.effect("fails with Go's byte-exact message when neither flag nor env is set", () =>
    Effect.gen(function* () {
      const error = yield* requireExperimental.pipe(
        Effect.provide(Layer.merge(withFlag(false), withShellEnv({}))),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ExperimentalRequiredError);
      expect(error.message).toBe("must set the --experimental flag to run this command");
    }),
  );

  it.effect("passes when SUPABASE_EXPERIMENTAL=1 even without the flag (viper AutomaticEnv)", () =>
    Effect.gen(function* () {
      const exit = yield* requireExperimental.pipe(
        Effect.provide(Layer.merge(withFlag(false), withShellEnv({ [ENV]: "1" }))),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect(
    "fails even with SUPABASE_EXPERIMENTAL=1 when --experimental=false is explicit (viper Changed wins)",
    () =>
      Effect.gen(function* () {
        const error = yield* requireExperimental.pipe(
          Effect.provide(
            Layer.merge(withFlag(false, ["--experimental=false"]), withShellEnv({ [ENV]: "1" })),
          ),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(ExperimentalRequiredError);
      }),
  );

  it.effect(
    "passes with SUPABASE_EXPERIMENTAL=1 when --experimental=false is a positional operand after --",
    () =>
      Effect.gen(function* () {
        const exit = yield* requireExperimental.pipe(
          Effect.provide(
            Layer.merge(
              withFlag(false, ["--", "--experimental=false"]),
              withShellEnv({ [ENV]: "1" }),
            ),
          ),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
      }),
  );

  it.effect(
    "a repeated --experimental=false --experimental=true keeps the LAST occurrence (viper Set() wins)",
    () =>
      Effect.gen(function* () {
        const exit = yield* requireExperimental.pipe(
          Effect.provide(
            withFlag(false, ["db", "pull", "--experimental=false", "--experimental=true"]),
          ),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
      }),
  );

  it.effect(
    "a repeated --experimental=true --experimental=false keeps the LAST occurrence (viper Set() wins)",
    () =>
      Effect.gen(function* () {
        const error = yield* requireExperimental.pipe(
          Effect.provide(
            withFlag(true, ["db", "pull", "--experimental=true", "--experimental=false"]),
          ),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(ExperimentalRequiredError);
      }),
  );

  it.effect("a repeated --experimental=false --experimental (bare) keeps the LAST occurrence", () =>
    Effect.gen(function* () {
      const exit = yield* requireExperimental.pipe(
        Effect.provide(withFlag(false, ["db", "pull", "--experimental=false", "--experimental"])),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});
