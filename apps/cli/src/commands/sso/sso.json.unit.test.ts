import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { decodeSsoJson } from "./sso.json.ts";

describe("SSO JSON codec compatibility", () => {
  it.effect("preserves native syntax errors for malformed JSON", () =>
    Effect.gen(function* () {
      for (const input of ["{not json}", "", "{", "[1,]", '{"a":}', "undefined"]) {
        const exit = yield* Effect.exit(decodeSsoJson(input));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(SyntaxError);
            expect(error.value.name).toBe("SyntaxError");
            expect(error.value.message.length).toBeGreaterThan(0);
            expect(String(error.value)).toBe(`SyntaxError: ${error.value.message}`);
          }
        }
      }
    }),
  );

  it.effect("retains open JSON values and user-defined keys", () =>
    Effect.gen(function* () {
      expect(yield* decodeSsoJson("null")).toBeNull();
      expect(yield* decodeSsoJson("3")).toBe(3);
      expect(yield* decodeSsoJson('"text"')).toBe("text");
      expect(yield* decodeSsoJson("true")).toBe(true);
      expect(yield* decodeSsoJson("1e400")).toBe(Infinity);
      expect(yield* decodeSsoJson('[1,null,{"default":3}]')).toEqual([1, null, { default: 3 }]);
      const parsed = yield* decodeSsoJson('{"keys":{"a":{"default":3}},"__proto__":{"safe":true}}');
      expect(parsed).toEqual({ keys: { a: { default: 3 } }, ["__proto__"]: { safe: true } });
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    }),
  );

  it.effect("leaves the standard schema error formatter unchanged", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))("{not json}"),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(Schema.SchemaError);
          expect(error.value.message).toBe("Expected a valid JSON string");
        }
      }
    }),
  );
});
