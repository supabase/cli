import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { LegacyExperimentalFlag } from "../../shared/legacy/global-flags.ts";
import {
  LegacyExperimentalRequiredError,
  legacyRequireExperimental,
} from "./legacy-experimental-gate.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";

const withFlag = (
  value: boolean,
  args: ReadonlyArray<string> = [],
  env: Readonly<Record<string, string>> = {},
) =>
  Layer.mergeAll(
    Layer.succeed(LegacyExperimentalFlag, value),
    Layer.succeed(CliArgs, { args }),
    makeLegacyViperEnvLayer(ConfigProvider.fromEnv({ env, preserveEmptyStrings: true })),
  );

describe("legacyRequireExperimental", () => {
  it.effect("passes when --experimental is set", () =>
    legacyRequireExperimental.pipe(Effect.provide(withFlag(true))),
  );

  it.effect("fails with Go's byte-exact message when neither flag nor env is set", () =>
    Effect.gen(function* () {
      const error = yield* legacyRequireExperimental.pipe(
        Effect.provide(withFlag(false)),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(LegacyExperimentalRequiredError);
      expect(error.message).toBe("must set the --experimental flag to run this command");
    }),
  );

  it.effect("passes when SUPABASE_EXPERIMENTAL=1 even without the flag (viper AutomaticEnv)", () =>
    Effect.gen(function* () {
      const exit = yield* legacyRequireExperimental.pipe(
        Effect.provide(withFlag(false, [], { SUPABASE_EXPERIMENTAL: "1" })),
        Effect.exit,
      );
      expect(exit._tag).toBe("Success");
    }),
  );

  it.effect(
    "fails even with SUPABASE_EXPERIMENTAL=1 when --experimental=false is explicit (viper Changed wins)",
    () =>
      Effect.gen(function* () {
        // viper's bound-pflag lookup returns the flag value whenever Changed is true —
        // BEFORE falling back to AutomaticEnv — so an
        // explicit --experimental=false must win over SUPABASE_EXPERIMENTAL=1.
        const error = yield* legacyRequireExperimental.pipe(
          Effect.provide(withFlag(false, ["--experimental=false"], { SUPABASE_EXPERIMENTAL: "1" })),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(LegacyExperimentalRequiredError);
      }),
  );

  it.effect(
    "passes with SUPABASE_EXPERIMENTAL=1 when --experimental=false is a positional operand after --",
    () =>
      Effect.gen(function* () {
        // Both pflag/cobra (a value placed after --
        // never sets cmd.Flags().Changed(...)) and this CLI's own lexer
        // (effect/unstable/cli/internal/lexer.ts, `argv.indexOf("--")`) stop parsing
        // flags at the first bare `--`. A positional operand that merely LOOKS like a
        // flag — e.g. a migration name literally called `--experimental=false` passed
        // as `db pull -- --experimental=false` — must not be mistaken for an explicit
        // `--experimental=false` and must not suppress the SUPABASE_EXPERIMENTAL=1
        // AutomaticEnv fallback.
        const exit = yield* legacyRequireExperimental.pipe(
          Effect.provide(
            withFlag(false, ["--", "--experimental=false"], { SUPABASE_EXPERIMENTAL: "1" }),
          ),
          Effect.exit,
        );
        expect(exit._tag).toBe("Success");
      }),
  );

  it.effect(
    "a repeated --experimental=false --experimental=true keeps the LAST occurrence (viper Set() wins)",
    () =>
      Effect.gen(function* () {
        // pflag/viper bind ONE variable per flag, so repeated occurrences collapse to
        // whichever Set() call happened last — verified empirically against the pinned
        // cobra@v1.10.2/pflag@v1.0.10/viper@v1.21.0 versions. A scan that
        // merely checks "does any pre-terminator token say false" gets this ordering
        // backwards and would incorrectly fail open here.
        const exit = yield* legacyRequireExperimental.pipe(
          Effect.provide(
            withFlag(false, ["db", "pull", "--experimental=false", "--experimental=true"]),
          ),
          Effect.exit,
        );
        expect(exit._tag).toBe("Success");
      }),
  );

  it.effect(
    "a repeated --experimental=true --experimental=false keeps the LAST occurrence (viper Set() wins)",
    () =>
      Effect.gen(function* () {
        const error = yield* legacyRequireExperimental.pipe(
          Effect.provide(
            withFlag(true, ["db", "pull", "--experimental=true", "--experimental=false"]),
          ),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(LegacyExperimentalRequiredError);
      }),
  );

  it.effect("a repeated --experimental=false --experimental (bare) keeps the LAST occurrence", () =>
    Effect.gen(function* () {
      const exit = yield* legacyRequireExperimental.pipe(
        Effect.provide(withFlag(false, ["db", "pull", "--experimental=false", "--experimental"])),
        Effect.exit,
      );
      expect(exit._tag).toBe("Success");
    }),
  );
});
