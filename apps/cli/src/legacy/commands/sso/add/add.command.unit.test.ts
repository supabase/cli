import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import { legacySsoAddDomainsFlag } from "./add.command.ts";

describe("legacy sso add --domains flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple domains", async () => {
    const [, domains] = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual(["example.com", "example.org"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, domains] = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org", "example.net"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual(["example.com", "example.org", "example.net"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, domains] = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `sso add --domains $'a.com\nb"c'` raises no
    // parse error — pflag calls `csv.Reader.Read()` once, so the malformed
    // second line is silently dropped.
    const [, domains] = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: { domains: ['a.com\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual(["a.com"]);
  });

  test("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: { domains: ['"example.com'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"example.com" for "--domains" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `sso add --domains $'\n'` →
    // `invalid argument "\n" for "--domains" flag: EOF`.
    const exit = await Effect.runPromise(
      legacySsoAddDomainsFlag
        .parse({
          flags: { domains: ["\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\n" for "--domains" flag: EOF',
      );
    }
  });
});
