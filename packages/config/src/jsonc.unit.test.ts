import { describe, expect, test } from "vitest";
import { JsoncSyntaxError, parseJsonc } from "./jsonc.ts";

function syntaxErrorFor(text: string): JsoncSyntaxError {
  try {
    parseJsonc(text);
  } catch (error) {
    if (error instanceof JsoncSyntaxError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseJsonc to throw");
}

describe("parseJsonc", () => {
  test("parses comments and trailing commas to the value strict JSON gives for the cleaned text", () => {
    const jsonc = `{
  // line comment
  "name": "a // not a comment",
  /* block
     comment */
  "list": [1, 2, {"x": null,},],
  "nested": {"on": true, "n": -1.5e2,},
}`;
    const strict = `{"name":"a // not a comment","list":[1,2,{"x":null}],"nested":{"on":true,"n":-1.5e2}}`;

    expect(parseJsonc(jsonc)).toEqual(JSON.parse(strict));
  });

  test("keeps a __proto__ key as an own property without changing the prototype", () => {
    const parsed = parseJsonc(`{"__proto__": {"polluted": true}, "safe": 1}`) as Record<
      string,
      unknown
    >;
    const strict = JSON.parse(`{"__proto__": {"polluted": true}, "safe": 1}`) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual({ polluted: true });
    expect(Object.keys(parsed)).toEqual(Object.keys(strict));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("keeps a nested __proto__ key as an own property", () => {
    const parsed = parseJsonc(`{"a": {"__proto__": 1}}`) as { a: Record<string, unknown> };

    expect(Object.getPrototypeOf(parsed.a)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.a, "__proto__")).toBe(true);
  });

  test("reports a 1-based line and column for a syntax error", () => {
    const error = syntaxErrorFor(`{\n  "a": 1,\n  "b": ,\n}`);

    expect(error).toBeInstanceOf(JsoncSyntaxError);
    expect(error.line).toBe(3);
    expect(error.column).toBe(8);
    expect(error.message).toBe(`${error.reason} (line 3, column 8)`);
  });

  test("reports line 1 column 1 for a leading syntax error", () => {
    const error = syntaxErrorFor(`}`);

    expect(error.line).toBe(1);
    expect(error.column).toBe(1);
  });

  test("never quotes the surrounding source in the error message", () => {
    const secret = "sk_live_SUPERSECRET123";
    const error = syntaxErrorFor(`{"token": "${secret}" "other": 1}`);

    expect(error.message).not.toContain(secret);
    expect(error.reason).not.toContain(secret);
    expect(error.message).toMatch(/\(line 1, column \d+\)$/);
  });

  test("accepts a leading BOM", () => {
    expect(parseJsonc(`﻿{"a": 1}`)).toEqual({ a: 1 });
  });

  test("throws on an empty document", () => {
    expect(() => parseJsonc("")).toThrow(JsoncSyntaxError);
    expect(() => parseJsonc("  // only a comment\n")).toThrow(JsoncSyntaxError);
  });
});
