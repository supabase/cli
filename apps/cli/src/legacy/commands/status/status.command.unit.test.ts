import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
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

  test("rejects malformed CSV (unterminated quote)", async () => {
    const exit = await Effect.runPromise(
      legacyStatusOverrideNameFlag
        .parse({ flags: { "override-name": ['"api.url=FOO'] }, arguments: [] })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
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
});
