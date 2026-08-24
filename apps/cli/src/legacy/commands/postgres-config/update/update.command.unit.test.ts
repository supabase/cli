import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import { legacyPostgresConfigUpdateConfigFlag } from "./update.command.ts";

describe("legacy postgres-config update --config flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple key=value pairs", () =>
    Effect.gen(function* () {
      const [, values] = yield* legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["max_connections=100,statement_timeout=600"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["max_connections=100", "statement_timeout=600"]);
    }),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, values] = yield* legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["max_connections=100,statement_timeout=600", "custom_key=alpha"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["max_connections=100", "statement_timeout=600", "custom_key=alpha"]);
    }),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      // Go-verified (CLI-2005): `postgres-config update --config $'a=1\nb"2'`
      // raises no parse error — pflag calls `csv.Reader.Read()` once, so the
      // malformed second line is silently dropped.
      const [, values] = yield* legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['a=1\nb"2'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["a=1"]);
    }),
  );

  it.live("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ['"max_connections=100'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Matches pflag's own diagnostic (`"max_connections=100` is 20 bytes →
        // EOF at column 21).
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"max_connections=100" for "--config" flag: parse error on line 1, column 21: extraneous or missing " in quoted-field',
        );
      }
    }),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      // Go-verified (CLI-2005): `postgres-config update --config $'\n'` →
      // `invalid argument "\n" for "--config" flag: EOF`.
      const exit = yield* legacyPostgresConfigUpdateConfigFlag
        .parse({
          flags: { config: ["\n"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "--config" flag: EOF',
        );
      }
    }),
  );
});
