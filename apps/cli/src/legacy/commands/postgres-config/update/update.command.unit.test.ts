import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { legacyPostgresConfigUpdateConfigFlag } from "./update.command.ts";

describe("legacy postgres-config update --config flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple key=value pairs", async () => {
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["max_connections=100,statement_timeout=600"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["max_connections=100", "statement_timeout=600"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["max_connections=100,statement_timeout=600", "custom_key=alpha"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["max_connections=100", "statement_timeout=600", "custom_key=alpha"]);
  });

  test("rejects malformed CSV (unterminated quote)", async () => {
    const exit = await Effect.runPromise(
      legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['"max_connections=100'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
