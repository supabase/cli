import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import {
  ssoUpdateAddDomainsFlag,
  ssoUpdateDomainsFlag,
  ssoUpdateRemoveDomainsFlag,
} from "./update.command.ts";

describe("sso update domain flags (pflag StringSlice parity)", () => {
  it.live("--domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoUpdateDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.live("--add-domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, addDomains] = yield* ssoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(addDomains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.live("--remove-domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, removeDomains] = yield* ssoUpdateRemoveDomainsFlag
        .parse({
          flags: { "remove-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(removeDomains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.live("--domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoUpdateDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual([]);
    }),
  );

  it.live("--add-domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, addDomains] = yield* ssoUpdateAddDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(addDomains).toEqual([]);
    }),
  );

  it.live("--remove-domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, removeDomains] = yield* ssoUpdateRemoveDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(removeDomains).toEqual([]);
    }),
  );

  it.live("--domains= (explicit empty value) parses to an empty array, not a missing flag", () =>
    Effect.gen(function* () {
      // The handler's `hasExplicitLongFlag` reads raw argv rather than this
      // parsed value, since `--domains=` collapses to `[]` here — indistinguishable
      // from an absent flag by `.length` alone.
      const [, domains] = yield* ssoUpdateDomainsFlag
        .parse({
          flags: { domains: [""] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual([]);
    }),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoUpdateDomainsFlag
        .parse({
          flags: { domains: ['a.com\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual(["a.com"]);
    }),
  );

  it.live("--domains rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoUpdateDomainsFlag
        .parse({
          flags: { domains: ['example"com'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "example\\"com" for "--domains" flag: parse error on line 1, column 8: bare " in non-quoted-field',
        );
      }
    }),
  );

  it.live("--add-domains rejects malformed CSV with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"x" for "--add-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.live("--remove-domains rejects malformed CSV with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoUpdateRemoveDomainsFlag
        .parse({
          flags: { "remove-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"x" for "--remove-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ["\n\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n\\n" for "--add-domains" flag: EOF',
        );
      }
    }),
  );
});
