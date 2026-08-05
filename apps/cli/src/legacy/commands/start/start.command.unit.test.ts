import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { legacyStartExcludeFlag } from "./start.command.ts";

describe("legacy start --exclude flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple exclusions", async () => {
    const [, exclude] = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["gotrue", "realtime"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, exclude] = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime", "studio"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["gotrue", "realtime", "studio"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, exclude] = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `start -x $'a\nb"c'` raises no parse error and
    // excludes only `a` — pflag calls `csv.Reader.Read()` once, so the
    // malformed second line is silently dropped.
    const [, exclude] = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ['a\nb"c'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["a"]);
  });

  test("rejects malformed CSV with pflag's shorthand-framed diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Go declares the flag with `StringSliceVarP(..., "exclude", "x", ...)`
      // (`cmd/start.go:58`), so pflag frames the diagnostic with BOTH
      // spellings — `-x, --exclude` — regardless of which one was typed
      // (pflag v1.0.10 `errors.go:108-117`). Go-verified (CLI-2005).
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "a\\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `start -x $'\n'` →
    // `invalid argument "\n" for "-x, --exclude" flag: EOF`.
    const exit = await Effect.runPromise(
      legacyStartExcludeFlag
        .parse({ flags: { exclude: ["\n"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\n" for "-x, --exclude" flag: EOF',
      );
    }
  });
});
