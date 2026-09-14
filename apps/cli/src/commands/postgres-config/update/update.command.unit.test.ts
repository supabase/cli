import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { postgresConfigUpdateConfigFlag } from "./update.command.ts";

describe("postgres-config update --config flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple key=value pairs", async () => {
    const [, values] = await Effect.runPromise(
      postgresConfigUpdateConfigFlag
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
      postgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["max_connections=100,statement_timeout=600", "custom_key=alpha"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["max_connections=100", "statement_timeout=600", "custom_key=alpha"]);
  });

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    const [, values] = await Effect.runPromise(
      postgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['a=1\nb"2'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["a=1"]);
  });

  test("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", async () => {
    const exit = await Effect.runPromise(
      postgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['"max_connections=100'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // `"max_connections=100` is 20 bytes, so pflag's CSV reader hits EOF at column 21.
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"max_connections=100" for "--config" flag: parse error on line 1, column 21: extraneous or missing " in quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    const exit = await Effect.runPromise(
      postgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\n" for "--config" flag: EOF',
      );
    }
  });
});
