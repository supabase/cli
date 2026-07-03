import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
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

  test("rejects malformed CSV (unterminated quote)", async () => {
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
  });
});
