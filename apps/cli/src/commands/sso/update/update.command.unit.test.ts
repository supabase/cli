import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import {
  ssoUpdateAddDomainsFlag,
  ssoUpdateDomainsFlag,
  ssoUpdateRemoveDomainsFlag,
} from "./update.command.ts";

describe("sso update domain flags (pflag StringSlice parity)", () => {
  test("--domains splits a comma-separated value into multiple domains", async () => {
    const [, domains] = await Effect.runPromise(
      ssoUpdateDomainsFlag
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
      ssoUpdateAddDomainsFlag
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
      ssoUpdateRemoveDomainsFlag
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
      ssoUpdateDomainsFlag
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
      ssoUpdateAddDomainsFlag
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
      ssoUpdateRemoveDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(removeDomains).toEqual([]);
  });

  test("--domains= (explicit empty value) parses to an empty array, not a missing flag", async () => {
    // The handler's `hasExplicitLongFlag` reads raw argv rather than this
    // parsed value, since `--domains=` collapses to `[]` here — indistinguishable
    // from an absent flag by `.length` alone.
    const [, domains] = await Effect.runPromise(
      ssoUpdateDomainsFlag
        .parse({
          flags: { domains: [""] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(domains).toEqual([]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    const [, domains] = await Effect.runPromise(
      ssoUpdateDomainsFlag
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
      ssoUpdateDomainsFlag
        .parse({
          flags: { domains: ['example"com'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "example\\"com" for "--domains" flag: parse error on line 1, column 8: bare " in non-quoted-field',
      );
    }
  });

  test("--add-domains rejects malformed CSV with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      ssoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"x" for "--add-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
      );
    }
  });

  test("--remove-domains rejects malformed CSV with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      ssoUpdateRemoveDomainsFlag
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
    const exit = await Effect.runPromise(
      ssoUpdateAddDomainsFlag
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
