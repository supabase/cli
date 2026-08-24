import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { legacyStatusExcludeFlag, legacyStatusOverrideNameFlag } from "./status.command.ts";

const parseOverride = (flags: Record<string, ReadonlyArray<string>>) =>
  legacyStatusOverrideNameFlag
    .parse({ flags, arguments: [] })
    .pipe(Effect.provide(BunServices.layer));

const parseExclude = (flags: Record<string, ReadonlyArray<string>>) =>
  legacyStatusExcludeFlag.parse({ flags, arguments: [] }).pipe(Effect.provide(BunServices.layer));

describe("legacy status --override-name flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple overrides", () =>
    Effect.runPromise(parseOverride({ "override-name": ["api.url=FOO,db.url=BAR"] })).then(
      ([, overrideName]) => {
        expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR"]);
      },
    ));

  test("accumulates repeated occurrences, each CSV-split", () =>
    Effect.runPromise(
      parseOverride({ "override-name": ["api.url=FOO,db.url=BAR", "studio.url=BAZ"] }),
    ).then(([, overrideName]) => {
      expect(overrideName).toEqual(["api.url=FOO", "db.url=BAR", "studio.url=BAZ"]);
    }));

  test("defaults to an empty array when unset", () =>
    Effect.runPromise(parseOverride({})).then(([, overrideName]) => {
      expect(overrideName).toEqual([]);
    }));

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.runPromise(parseOverride({ "override-name": ['a=1\nb"2'] })).then(([, overrideName]) => {
      expect(overrideName).toEqual(["a=1"]);
    }));

  test("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", () =>
    Effect.runPromise(parseOverride({ "override-name": ['"api.url=FOO'] }).pipe(Effect.exit)).then(
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "\\"api.url=FOO" for "--override-name" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
          );
        }
      },
    ));

  test("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.runPromise(parseOverride({ "override-name": ["\n"] }).pipe(Effect.exit)).then((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "--override-name" flag: EOF',
        );
      }
    }));
});

describe("legacy status --exclude flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple exclusions", () =>
    Effect.runPromise(parseExclude({ exclude: ["kong,auth"] })).then(([, exclude]) => {
      expect(exclude).toEqual(["kong", "auth"]);
    }));

  test("defaults to an empty array when unset", () =>
    Effect.runPromise(parseExclude({})).then(([, exclude]) => {
      expect(exclude).toEqual([]);
    }));

  test("rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.runPromise(parseExclude({ exclude: ['a"b'] }).pipe(Effect.exit)).then((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "a\\"b" for "--exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
        );
      }
    }));
});
