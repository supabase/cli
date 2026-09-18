import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { postgresConfigUpdateConfigFlag } from "./update.command.ts";

describe("postgres-config update --config flag (pflag StringSlice parity)", () => {
  it.live("splits a comma-separated value into multiple key=value pairs", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigUpdateConfigFlag.parse({
        flags: { config: ["max_connections=100,statement_timeout=600"] },
        arguments: [],
      });

      expect(values).toEqual(["max_connections=100", "statement_timeout=600"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("accumulates repeated occurrences, each CSV-split", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigUpdateConfigFlag.parse({
        flags: { config: ["max_connections=100,statement_timeout=600", "custom_key=alpha"] },
        arguments: [],
      });

      expect(values).toEqual(["max_connections=100", "statement_timeout=600", "custom_key=alpha"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps only the first CSV record of a multiline value (pflag reads ONE record)", () =>
    Effect.gen(function* () {
      const [, values] = yield* postgresConfigUpdateConfigFlag.parse({
        flags: { config: ['a=1\nb"2'] },
        arguments: [],
      });

      expect(values).toEqual(["a=1"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects malformed CSV (unterminated quote) with pflag's exact diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdateConfigFlag.parse({
          flags: { config: ['"max_connections=100'] },
          arguments: [],
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // `"max_connections=100` is 20 bytes, so pflag's CSV reader hits EOF at column 21.
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "\\"max_connections=100" for "--config" flag: parse error on line 1, column 21: extraneous or missing " in quoted-field',
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects a blank-only value with pflag's EOF diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdateConfigFlag.parse({
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
