import { describe, expect, it } from "@effect/vitest";
import { parse } from "dotenv";
import { Effect } from "effect";
import { encodeStackEnv } from "./status.env.ts";

describe("stack dotenv encoding", () => {
  it.effect("round-trips literal credentials without expanding or changing characters", () =>
    Effect.gen(function* () {
      const values = {
        TOKEN: "000123",
        SECRET: "literal\\n$HOME#hash=equals\nnew line",
        QUOTED: "it's a secret",
        MIXED: "it's a `secret`",
        EMPTY: "",
      };
      const encoded = yield* encodeStackEnv(values);
      expect(parse(encoded)).toEqual(values);
    }),
  );

  it.effect("fails without exposing values that dotenv cannot represent losslessly", () =>
    Effect.gen(function* () {
      for (const value of ["all'three`quotes\"", "both'and`quotes\\n", "carriage\rreturn"]) {
        const error = yield* encodeStackEnv({ SECRET: value }).pipe(Effect.flip);
        expect(error.reason).toBe("output");
      }
    }),
  );
});
