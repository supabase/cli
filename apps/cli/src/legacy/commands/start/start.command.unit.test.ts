import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { legacyStartExcludeFlag } from "./start.command.ts";

describe("legacy start --exclude flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple exclusions", () =>
    Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    ).then(([, exclude]) => {
      expect(exclude).toEqual(["gotrue", "realtime"]);
    }));

  test("accumulates repeated occurrences, each CSV-split", () =>
    Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime", "studio"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    ).then(([, exclude]) => {
      expect(exclude).toEqual(["gotrue", "realtime", "studio"]);
    }));

  test("defaults to an empty array when unset", () =>
    Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    ).then(([, exclude]) => {
      expect(exclude).toEqual([]);
    }));

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () => {
    // Verified against pflag's actual CSV behavior (CLI-2005): `start -x $'a\nb"c'`
    // raises no parse error and excludes only `a` — pflag calls
    // `csv.Reader.Read()` once, so the malformed second line is silently dropped.
    return Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ['a\nb"c'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    ).then(([, exclude]) => {
      expect(exclude).toEqual(["a"]);
    });
  });

  test("rejects malformed CSV with pflag's shorthand-framed diagnostic", () =>
    Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit),
    ).then((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // The flag has both a shorthand and long spelling, so pflag frames the
        // diagnostic with BOTH spellings — `-x, --exclude` — regardless of which
        // one was typed. Verified against pflag's actual output (CLI-2005).
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "a\\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
        );
      }
    }));

  test("rejects a blank-only value with pflag's EOF diagnostic", () =>
    // Verified against pflag's actual output (CLI-2005): `start -x $'\n'` →
    // `invalid argument "\n" for "-x, --exclude" flag: EOF`.
    Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["\n"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit),
    ).then((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "-x, --exclude" flag: EOF',
        );
      }
    }));
});
