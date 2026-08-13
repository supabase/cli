import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import {
  legacySsoUpdateAddDomainsFlag,
  legacySsoUpdateDomainsFlag,
  legacySsoUpdateRemoveDomainsFlag,
} from "./update.command.ts";

describe("legacy sso update domain flags (pflag StringSlice parity)", () => {
  test("--domains splits a comma-separated value into multiple domains", async () => {
    const [, domains] = await Effect.runPromise(
      legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual(["example.com", "example.org"]);
  });

  test("--add-domains splits a comma-separated value into multiple domains", async () => {
    const [, addDomains] = await Effect.runPromise(
      legacySsoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(addDomains).toEqual(["example.com", "example.org"]);
  });

  test("--remove-domains splits a comma-separated value into multiple domains", async () => {
    const [, removeDomains] = await Effect.runPromise(
      legacySsoUpdateRemoveDomainsFlag
        .parse({
          flags: { "remove-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(removeDomains).toEqual(["example.com", "example.org"]);
  });

  test("--domains defaults to an empty array when unset", async () => {
    const [, domains] = await Effect.runPromise(
      legacySsoUpdateDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual([]);
  });

  test("--add-domains defaults to an empty array when unset", async () => {
    const [, addDomains] = await Effect.runPromise(
      legacySsoUpdateAddDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(addDomains).toEqual([]);
  });

  test("--remove-domains defaults to an empty array when unset", async () => {
    const [, removeDomains] = await Effect.runPromise(
      legacySsoUpdateRemoveDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(removeDomains).toEqual([]);
  });

  test("--domains= (explicit empty value) parses to an empty array, not a missing flag", async () => {
    // Backs the "changed vs truthy" mutex-check fix (CLI-1902): the handler's
    // `hasExplicitLongFlag` reads raw argv rather than this parsed value
    // precisely because `--domains=` collapses to `[]` here, indistinguishable
    // from the flag never being passed at all if you only looked at `.length`.
    const [, domains] = await Effect.runPromise(
      legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: [""] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `sso update <id> --domains $'a.com\nb"c'` raises
    // no parse error — pflag calls `csv.Reader.Read()` once, so the malformed
    // second line is silently dropped.
    const [, domains] = await Effect.runPromise(
      legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: ['a.com\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual(["a.com"]);
  });

  test("--domains rejects malformed CSV (bare quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: ['example"com'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Byte-matches the Go CLI (bare quote at byte 8 of `example"com`).
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "example\\"com" for "--domains" flag: parse error on line 1, column 8: bare " in non-quoted-field',
      );
    }
  });

  test("--add-domains rejects malformed CSV with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacySsoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Go-verified (CLI-2005): `"x` is 2 bytes → EOF at column 3.
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"x" for "--add-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
      );
    }
  });

  test("--remove-domains rejects malformed CSV with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      legacySsoUpdateRemoveDomainsFlag
        .parse({
          flags: { "remove-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"x" for "--remove-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `sso update <id> --add-domains $'\n\n'` →
    // `invalid argument "\n\n" for "--add-domains" flag: EOF`.
    const exit = await Effect.runPromise(
      legacySsoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ["\n\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\n\\n" for "--add-domains" flag: EOF',
      );
    }
  });
});
