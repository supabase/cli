import { describe, expect, it } from "@effect/vitest";
import { parse } from "dotenv";
import { Effect, Exit } from "effect";
import { legacyEncodeStackEnv } from "./status.env.ts";

describe("stack dotenv encoding", () => {
  it.effect("round-trips literal credentials without expanding or changing characters", () =>
    Effect.gen(function* () {
      const values = {
        TOKEN: "000123",
        SECRET: "literal\\n$HOME#hash=equals\nnew line",
        QUOTED: "it's a secret",
        EMPTY: "",
      };
      const encoded = yield* legacyEncodeStackEnv(values);
      expect(parse(encoded)).toEqual(values);
    }),
  );

  it.effect("fails without exposing values that dotenv cannot represent losslessly", () =>
    Effect.gen(function* () {
      for (const value of ["both'and`quotes", "carriage\rreturn"]) {
        const result = yield* legacyEncodeStackEnv({ SECRET: value }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }
    }),
  );
});
