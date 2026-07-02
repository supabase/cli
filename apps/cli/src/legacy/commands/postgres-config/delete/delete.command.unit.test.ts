import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { legacyPostgresConfigDeleteConfigFlag } from "./delete.command.ts";

describe("legacy postgres-config delete --config flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple keys", async () => {
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ["max_connections,statement_timeout"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["max_connections", "statement_timeout"]);
  });

  test("accumulates repeated occurrences, each CSV-split", async () => {
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ["max_connections,statement_timeout", "custom_key"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["max_connections", "statement_timeout", "custom_key"]);
  });

  test("rejects malformed CSV (bare quote)", async () => {
    const exit = await Effect.runPromise(
      legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ['max"connections'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
