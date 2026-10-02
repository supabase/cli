import { it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { startExcludeFlag } from "./start.command.ts";

describe("start --exclude flag (pflag StringSlice parity)", () => {
  it.effect("splits a comma-separated value into multiple exclusions", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* startExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual(["gotrue", "realtime"]);
    }),
  );

  it.effect("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* startExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime", "studio"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual(["gotrue", "realtime", "studio"]);
    }),
  );

  it.effect("defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* startExcludeFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual([]);
    }),
  );

  it.effect("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* startExcludeFlag
        .parse({ flags: { exclude: ['a\nb"c'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual(["a"]);
    }),
  );

  it.effect("rejects malformed CSV with pflag's shorthand-framed diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* startExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "a\\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
        );
      }
    }),
  );

  it.effect("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* startExcludeFlag
        .parse({ flags: { exclude: ["\n"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "-x, --exclude" flag: EOF',
        );
      }
    }),
  );
});
