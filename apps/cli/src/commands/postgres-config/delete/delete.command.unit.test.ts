import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { postgresConfigDeleteConfigFlag } from "./delete.command.ts";

describe("postgres-config delete --config flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple keys", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigDeleteConfigFlag.parse({
        flags: { config: ["max_connections,statement_timeout"] },
        arguments: [],
      });

      expect(values).toEqual(["max_connections", "statement_timeout"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigDeleteConfigFlag.parse({
        flags: { config: ["max_connections,statement_timeout", "custom_key"] },
        arguments: [],
      });

      expect(values).toEqual(["max_connections", "statement_timeout", "custom_key"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigDeleteConfigFlag.parse({
        flags: { config: ['a\nb"c'] },
        arguments: [],
      });

      expect(values).toEqual(["a"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects malformed CSV (bare quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDeleteConfigFlag.parse({
          flags: { config: ['max"connections'] },
          arguments: [],
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Bare quote at byte 4 of `max"connections`.
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "max\\"connections" for "--config" flag: parse error on line 1, column 4: bare " in non-quoted-field',
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDeleteConfigFlag.parse({
          flags: { config: ["\n"] },
          arguments: [],
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\n" for "--config" flag: EOF',
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
