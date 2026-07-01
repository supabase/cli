import { describe, expect, test } from "vitest";
import { resolveModel } from "./select-model.ts";

describe("resolveModel", () => {
  test("defaults to anthropic/claude-haiku-4-5 with no flags or env", () => {
    expect(resolveModel({}, {})).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });

  test("--model provider/model wins over everything", () => {
    expect(
      resolveModel(
        { model: "openai/gpt-5-mini", provider: "anthropic" },
        { RELEASE_NOTES_MODEL: "anthropic/claude-opus-4" },
      ),
    ).toEqual({ providerID: "openai", modelID: "gpt-5-mini" });
  });

  test("--provider shorthand resolves to the provider's default model", () => {
    expect(resolveModel({ provider: "openai" }, {})).toEqual({
      providerID: "openai",
      modelID: "gpt-5-mini",
    });
  });

  test("--provider aliases: claude -> anthropic, codex -> openai", () => {
    expect(resolveModel({ provider: "claude" }, {}).providerID).toBe("anthropic");
    expect(resolveModel({ provider: "codex" }, {}).providerID).toBe("openai");
  });

  test("--provider is case-insensitive", () => {
    expect(resolveModel({ provider: "OpenAI" }, {}).providerID).toBe("openai");
  });

  test("--provider wins over RELEASE_NOTES_MODEL env", () => {
    expect(
      resolveModel({ provider: "openai" }, { RELEASE_NOTES_MODEL: "anthropic/claude-haiku-4-5" }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5-mini" });
  });

  test("RELEASE_NOTES_MODEL env is used when no flags are given", () => {
    expect(resolveModel({}, { RELEASE_NOTES_MODEL: "openai/gpt-5" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });

  test("empty-string flags are ignored and fall through to the default", () => {
    expect(resolveModel({ model: "", provider: "" }, {})).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });

  test("model id may itself contain slashes (only the first slash splits)", () => {
    expect(resolveModel({ model: "openrouter/anthropic/claude-3.5" }, {})).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-3.5",
    });
  });

  test.each(["justamodel", "openai/", "/gpt-5", "  "])(
    "throws on malformed --model %j",
    (value) => {
      expect(() => resolveModel({ model: value }, {})).toThrow(/provider\/model/);
    },
  );

  test("throws on unknown --provider", () => {
    expect(() => resolveModel({ provider: "gemini" }, {})).toThrow(/Unknown --provider/);
  });
});
