import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
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

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `postgres-config update --config $'a=1\nb"2'`
    // raises no parse error — pflag calls `csv.Reader.Read()` once, so the
    // malformed second line is silently dropped.
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigUpdateConfigFlag
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
      legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['"max_connections=100'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Matches pflag's own diagnostic (`"max_connections=100` is 20 bytes →
      // EOF at column 21).
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "\\"max_connections=100" for "--config" flag: parse error on line 1, column 21: extraneous or missing " in quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `postgres-config update --config $'\n'` →
    // `invalid argument "\n" for "--config" flag: EOF`.
    const exit = await Effect.runPromise(
      legacyPostgresConfigUpdateConfigFlag
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
