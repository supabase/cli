import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
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

  test("keeps only the first CSV record of a multiline value (pflag reads ONE record)", async () => {
    // Go-verified (CLI-2005): `postgres-config delete --config $'a\nb"c'`
    // raises no parse error — pflag calls `csv.Reader.Read()` once, so the
    // malformed second line is silently dropped.
    const [, values] = await Effect.runPromise(
      legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ['a\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(values).toEqual(["a"]);
  });

  test("rejects malformed CSV (bare quote) with pflag's exact diagnostic", async () => {
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
    if (Exit.isFailure(exit)) {
      // Byte-matches the Go CLI (bare quote at byte 4 of `max"connections`).
      expect(normalizeCause(exit.cause).message).toBe(
        'invalid argument "max\\"connections" for "--config" flag: parse error on line 1, column 4: bare " in non-quoted-field',
      );
    }
  });

  test("rejects a blank-only value with pflag's EOF diagnostic", async () => {
    // Go-verified (CLI-2005): `postgres-config delete --config $'\n'` →
    // `invalid argument "\n" for "--config" flag: EOF`.
    const exit = await Effect.runPromise(
      legacyPostgresConfigDeleteConfigFlag
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
