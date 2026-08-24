import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import { legacyPostgresConfigDeleteConfigFlag } from "./delete.command.ts";

describe("legacy postgres-config delete --config flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple keys", () =>
    Effect.gen(function* () {
      const [, values] = yield* legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ["max_connections,statement_timeout"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["max_connections", "statement_timeout"]);
    }),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, values] = yield* legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ["max_connections,statement_timeout", "custom_key"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["max_connections", "statement_timeout", "custom_key"]);
    }),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      // Go-verified (CLI-2005): `postgres-config delete --config $'a\nb"c'`
      // raises no parse error — pflag calls `csv.Reader.Read()` once, so the
      // malformed second line is silently dropped.
      const [, values] = yield* legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ['a\nb"c'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer));
      expect(values).toEqual(["a"]);
    }),
  );

  it.live("rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* legacyPostgresConfigDeleteConfigFlag
        .parse({
          flags: { config: ['max"connections'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Matches pflag's own diagnostic (bare quote at byte 4 of `max"connections`).
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "max\\"connections" for "--config" flag: parse error on line 1, column 4: bare " in non-quoted-field',
        );
      }
    }),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      // Go-verified (CLI-2005): `postgres-config delete --config $'\n'` →
      // `invalid argument "\n" for "--config" flag: EOF`.
      const exit = yield* legacyPostgresConfigDeleteConfigFlag
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
