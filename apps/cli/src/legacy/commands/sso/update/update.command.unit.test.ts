import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import {
  legacySsoUpdateAddDomainsFlag,
  legacySsoUpdateDomainsFlag,
  legacySsoUpdateRemoveDomainsFlag,
} from "./update.command.ts";

describe("legacy sso update domain flags (pflag StringSlice parity)", () => {
  it.effect("--domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, domains] = yield* legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(domains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.effect("--add-domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, addDomains] = yield* legacySsoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(addDomains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.effect("--remove-domains splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, removeDomains] = yield* legacySsoUpdateRemoveDomainsFlag
        .parse({
          flags: { "remove-domains": ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(removeDomains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.effect("--domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, domains] = yield* legacySsoUpdateDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(domains).toEqual([]);
    }),
  );

  it.effect("--add-domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, addDomains] = yield* legacySsoUpdateAddDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(addDomains).toEqual([]);
    }),
  );

  it.effect("--remove-domains defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, removeDomains] = yield* legacySsoUpdateRemoveDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(removeDomains).toEqual([]);
    }),
  );

  it.effect("--domains= (explicit empty value) parses to an empty array, not a missing flag", () =>
    Effect.gen(function* () {
      // The handler's `hasExplicitLongFlag` reads raw argv rather than this
      // parsed value precisely because `--domains=` collapses to `[]` here,
      // indistinguishable from the flag never being passed at all if you only
      // looked at `.length`.
      const [, domains] = yield* legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: [""] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(domains).toEqual([]);
    }),
  );

  it.effect("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      // `sso update <id> --domains $'a.com\nb"c'` raises no parse error —
      // pflag calls `csv.Reader.Read()` once, so the malformed second line is
      // silently dropped.
      const [, domains] = yield* legacySsoUpdateDomainsFlag
        .parse({
          flags: { domains: ['a.com\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(domains).toEqual(["a.com"]);
    }),
  );

  it.effect("--domains rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* legacySsoUpdateDomainsFlag
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

  it.effect("--add-domains rejects malformed CSV with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* legacySsoUpdateAddDomainsFlag
        .parse({
          flags: { "add-domains": ['"x'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Go-verified (CLI-2005): `"x` is 2 bytes → EOF at column 3.
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"x" for "--add-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.effect("--remove-domains rejects malformed CSV with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* legacySsoUpdateRemoveDomainsFlag
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

  it.effect("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      // Go-verified (CLI-2005): `sso update <id> --add-domains $'\n\n'` →
      // `invalid argument "\n\n" for "--add-domains" flag: EOF`.
      const exit = yield* legacySsoUpdateAddDomainsFlag
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
