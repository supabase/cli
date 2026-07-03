import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
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

  test("rejects malformed CSV (bare quote)", async () => {
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
  });
});
