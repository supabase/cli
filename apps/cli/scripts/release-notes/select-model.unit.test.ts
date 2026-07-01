import { describe, expect, test } from "vitest";
import { resolveModel } from "./select-model.ts";

describe("resolveModel", () => {
  test("defaults to anthropic/claude-haiku-4-5 with no flag or env", () => {
    expect(resolveModel({}, {})).toBe("anthropic/claude-haiku-4-5");
  });

  test("--model wins over env", () => {
    expect(
      resolveModel(
        { model: "openai/gpt-5-mini" },
        { RELEASE_NOTES_MODEL: "anthropic/claude-opus-4" },
      ),
    ).toBe("openai/gpt-5-mini");
  });

  test("RELEASE_NOTES_MODEL env is used when no flag is given", () => {
    expect(resolveModel({}, { RELEASE_NOTES_MODEL: "openai/gpt-5" })).toBe("openai/gpt-5");
  });

  test("empty-string flag is ignored and falls through to the default", () => {
    expect(resolveModel({ model: "" }, {})).toBe("anthropic/claude-haiku-4-5");
  });

  test("empty-string env is ignored and falls through to the default", () => {
    expect(resolveModel({}, { RELEASE_NOTES_MODEL: "" })).toBe("anthropic/claude-haiku-4-5");
  });

  test("trims surrounding whitespace", () => {
    expect(resolveModel({ model: "  openai/gpt-5-mini  " }, {})).toBe("openai/gpt-5-mini");
  });

  test("keeps model ids that themselves contain slashes", () => {
    expect(resolveModel({ model: "openrouter/anthropic/claude-3.5" }, {})).toBe(
      "openrouter/anthropic/claude-3.5",
    );
  });

  test.each(["justamodel", "openai/", "/gpt-5", "  "])(
    "throws on malformed --model %j",
    (value) => {
      expect(() => resolveModel({ model: value }, {})).toThrow(/provider\/model/);
    },
  );

  test("throws on malformed RELEASE_NOTES_MODEL env", () => {
    expect(() => resolveModel({}, { RELEASE_NOTES_MODEL: "nope" })).toThrow(/provider\/model/);
  });
});
