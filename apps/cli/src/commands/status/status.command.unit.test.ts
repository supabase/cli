import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { statusExcludeFlag, statusOverrideNameFlag } from "./status.command.ts";

describe("status --override-name flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple overrides", () =>
    Effect.gen(function* () {
      const [, overrideName] = yield* statusOverrideNameFlag
        .parse({
          flags: { "override-name": ["api.url=FOO,db.url=BAR"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR"]);
    }),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, overrideName] = yield* statusOverrideNameFlag
        .parse({
          flags: { "override-name": ["api.url=FOO,db.url=BAR", "studio.url=BAZ"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR", "studio.url=BAZ"]);
    }),
  );

  it.live("defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, overrideName] = yield* statusOverrideNameFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(overrideName).toEqual([]);
    }),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, overrideName] = yield* statusOverrideNameFlag
        .parse({ flags: { "override-name": ['a=1\nb"2'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(overrideName).toEqual(["a=1"]);
    }),
  );

  it.live("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* statusOverrideNameFlag
        .parse({ flags: { "override-name": ['"api.url=FOO'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"api.url=FOO" for "--override-name" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* statusOverrideNameFlag
        .parse({ flags: { "override-name": ["\n"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "--override-name" flag: EOF',
        );
      }
    }),
  );
});

describe("status --exclude flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple exclusions", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* statusExcludeFlag
        .parse({ flags: { exclude: ["kong,auth"] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual(["kong", "auth"]);
    }),
  );

  it.live("defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* statusExcludeFlag
        .parse({ flags: {}, arguments: [] })
        .pipe(Effect.provide(BunServices.layer));

      expect(exclude).toEqual([]);
    }),
  );

  it.live("rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* statusExcludeFlag
        .parse({ flags: { exclude: ['a"b'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "a\\"b" for "--exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
        );
      }
    }),
  );
});
