import { afterEach, describe, expect, it } from "vitest";

import {
  viperEnvBool,
  viperEnvBoolWithProjectFallback,
  viperEnvStringWithProjectFallback,
} from "./viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";
const STRING_KEY = "SUPABASE_TEST_VIPER_STRING";

describe("viperEnvBool", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("is true only for strconv.ParseBool's true set (viper.GetBool parity)", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      process.env[KEY] = value;
      expect(viperEnvBool(KEY)).toBe(true);
    }
  });

  it("is false for the false set and any unrecognized value", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
      process.env[KEY] = value;
      expect(viperEnvBool(KEY)).toBe(false);
    }
  });

  it("is false when the env var is absent", () => {
    delete process.env[KEY];
    expect(viperEnvBool(KEY)).toBe(false);
  });
});

describe("viperEnvBoolWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("falls back to the project value only when the shell var is absent", () => {
    delete process.env[KEY];
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(true);
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(false);
    expect(viperEnvBoolWithProjectFallback(KEY, {})).toBe(false);
  });

  it("keeps a false shell override even when the project .env says true", () => {
    process.env[KEY] = "false";
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an empty shell value as present (blocks the project value) and false", () => {
    process.env[KEY] = "";
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an unparsable shell value as present and false (cast.ToBool swallows the error)", () => {
    process.env[KEY] = "banana";
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("keeps a true shell value over a false project value", () => {
    process.env[KEY] = "true";
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(true);
  });

  it("whenUnset: true resolves a key absent from both envs to true (opt-out gate default)", () => {
    delete process.env[KEY];
    expect(viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(true);
  });

  it("whenUnset: true still yields false for any present non-true value", () => {
    process.env[KEY] = "0";
    expect(viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(false);
    process.env[KEY] = "";
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }, { whenUnset: true })).toBe(
      false,
    );
    process.env[KEY] = "banana";
    expect(viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(false);
    delete process.env[KEY];
    expect(viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }, { whenUnset: true })).toBe(
      false,
    );
  });
});

describe("viperEnvStringWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[STRING_KEY];
  });

  it("falls back to the project value only when the shell var is absent", () => {
    delete process.env[STRING_KEY];
    expect(viperEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" })).toBe(
      "project-value",
    );
    expect(viperEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
  });

  it("keeps the shell value over a project value", () => {
    process.env[STRING_KEY] = "shell-value";
    expect(viperEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" })).toBe(
      "shell-value",
    );
  });

  it("treats an empty shell value as present (blocks the project value)", () => {
    process.env[STRING_KEY] = "";
    expect(viperEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" })).toBe(
      "",
    );
  });

  it("returns an empty string (not undefined) when absent from both, matching viper.GetString", () => {
    delete process.env[STRING_KEY];
    expect(viperEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
  });
});
