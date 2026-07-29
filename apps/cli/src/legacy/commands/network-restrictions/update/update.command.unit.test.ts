import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { legacyNetworkRestrictionsUpdateDbAllowCidrFlag } from "./update.command.ts";

// Go declares `--db-allow-cidr` with pflag's `StringSliceVar`
// (`cmd/restrictions.go:40`), which CSV-splits each occurrence and appends
// across repeats.
describe("legacy network-restrictions update --db-allow-cidr flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple CIDRs", async () => {
    const [, cidrs] = await Effect.runPromise(
      legacyNetworkRestrictionsUpdateDbAllowCidrFlag
        .parse({
          flags: { "db-allow-cidr": ["1.2.3.0/24,5.6.7.0/24"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(cidrs).toEqual(["1.2.3.0/24", "5.6.7.0/24"]);
  });

  test("keeps a quoted value with embedded comma as a single element", async () => {
    const [, cidrs] = await Effect.runPromise(
      legacyNetworkRestrictionsUpdateDbAllowCidrFlag
        .parse({
          flags: { "db-allow-cidr": ['"1.2.3.0/24,5.6.7.0/24"'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(cidrs).toEqual(["1.2.3.0/24,5.6.7.0/24"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, cidrs] = await Effect.runPromise(
      legacyNetworkRestrictionsUpdateDbAllowCidrFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(cidrs).toEqual([]);
  });

  test("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacyNetworkRestrictionsUpdateDbAllowCidrFlag
        .parse({
          flags: { "db-allow-cidr": ['"1.2.3.0/24'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    // Byte-matches the Go CLI (pflag v1.0.10 `errors.go:116` wrapping
    // `encoding/csv`'s error; `"1.2.3.0/24` is 11 bytes → EOF at column 12).
    const error = Cause.squash(exit.cause);
    expect(error).toMatchObject({
      _tag: "InvalidValue",
      expected:
        'invalid argument "\\"1.2.3.0/24" for "--db-allow-cidr" flag: parse error on line 1, column 12: extraneous or missing " in quoted-field',
    });
  });
});
