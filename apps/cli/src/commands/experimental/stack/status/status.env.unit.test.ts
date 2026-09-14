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
        EMPTY: "",
      };
      const encoded = yield* encodeStackEnv(values);
      expect(parse(encoded)).toEqual(values);
    }),
  );

  it.effect("quotes so that sourcing the file performs no shell expansion", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeStackEnv({ QUOTED: "it's a secret", PLAIN: "plain$(value)" });
      expect(encoded).toBe(`PLAIN='plain$(value)'\nQUOTED="it's a secret"\n`);
    }),
  );

  it.effect("fails without exposing values that cannot be written safely", () =>
    Effect.gen(function* () {
      for (const value of [
        "it's $(whoami)",
        "it's a `secret`",
        "it's !history",
        "it's a \\n escape",
        "all'three`quotes\"",
        "carriage\rreturn",
      ]) {
        const error = yield* encodeStackEnv({ SECRET: value }).pipe(Effect.flip);
        expect(error.reason).toBe("output");
      }
    }),
  );
});
