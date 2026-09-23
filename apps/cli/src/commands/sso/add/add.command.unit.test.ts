import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { ssoAddDomainsFlag } from "./add.command.ts";

describe("sso add --domains flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple domains", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoAddDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual(["example.com", "example.org"]);
    }),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoAddDomainsFlag
        .parse({
          flags: { domains: ["example.com,example.org", "example.net"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual(["example.com", "example.org", "example.net"]);
    }),
  );

  it.live("defaults to an empty array when unset", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoAddDomainsFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual([]);
    }),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, domains] = yield* ssoAddDomainsFlag
        .parse({
          flags: { domains: ['a.com\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));

      expect(domains).toEqual(["a.com"]);
    }),
  );

  it.live("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoAddDomainsFlag
        .parse({
          flags: { domains: ['"example.com'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"example.com" for "--domains" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* ssoAddDomainsFlag
        .parse({
          flags: { domains: ["\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "--domains" flag: EOF',
        );
      }
    }),
  );
});
