import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { startExcludeFlag } from "./start.command.ts";

describe("start --exclude flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple exclusions", async () => {
    const [, exclude] = await Effect.runPromise(
      startExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["gotrue", "realtime"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, exclude] = await Effect.runPromise(
      startExcludeFlag
        .parse({ flags: { exclude: ["gotrue,realtime", "studio"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["gotrue", "realtime", "studio"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, exclude] = await Effect.runPromise(
      startExcludeFlag.parse({ flags: {}, arguments: [] }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    const [, exclude] = await Effect.runPromise(
      startExcludeFlag
        .parse({ flags: { exclude: ['a\nb"c'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["a"]);
  });

  test("rejects malformed CSV with pflag's shorthand-framed diagnostic", async () => {
    const exit = await Effect.runPromise(
      startExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "a\\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    const exit = await Effect.runPromise(
      startExcludeFlag
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
