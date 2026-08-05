import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { legacyStatusExcludeFlag, legacyStatusOverrideNameFlag } from "./status.command.ts";

describe("legacy status --override-name flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple overrides", async () => {
    const [, overrideName] = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({
          flags: { "override-name": ["api.url=FOO,db.url=BAR"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, overrideName] = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({
          flags: { "override-name": ["api.url=FOO,db.url=BAR", "studio.url=BAZ"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR", "studio.url=BAZ"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, overrideName] = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(overrideName).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `status --override-name $'a=1\nb"2'` raises no
    // parse error — pflag calls `csv.Reader.Read()` once, so the malformed
    // second line is silently dropped.
    const [, overrideName] = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({ flags: { "override-name": ['a=1\nb"2'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(overrideName).toEqual(["a=1"]);
  });

  test("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({ flags: { "override-name": ['"api.url=FOO'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Byte-matches the Go CLI (`"api.url=FOO` is 12 bytes → EOF at column 13).
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"api.url=FOO" for "--override-name" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `status --override-name $'\n'` →
    // `invalid argument "\n" for "--override-name" flag: EOF`.
    const exit = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({ flags: { "override-name": ["\n"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\n" for "--override-name" flag: EOF',
      );
    }
  });
});

describe("legacy status --exclude flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple exclusions", async () => {
    const [, exclude] = await Effect.runPromise(
      legacyStatusExcludeFlag
        .parse({ flags: { exclude: ["kong,auth"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["kong", "auth"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, exclude] = await Effect.runPromise(
      legacyStatusExcludeFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual([]);
  });

  test("rejects malformed CSV (bare quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacyStatusExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Go-verified (CLI-2005): `status --exclude 'a"b'` — bare quote at byte 2.
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "a\\"b" for "--exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
      );
    }
  });
});
