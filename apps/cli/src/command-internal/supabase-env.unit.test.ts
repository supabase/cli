import { afterEach, describe, expect, it } from "vitest";

import {
  supabaseEnvBool,
  supabaseEnvBoolWithProjectFallback,
  supabaseEnvStringWithProjectFallback,
} from "./supabase-env.ts";

const KEY = "SUPABASE_TEST_ENV_BOOL";
const STRING_KEY = "SUPABASE_TEST_ENV_STRING";

describe("supabaseEnvBool", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("is true only for strconv.ParseBool's true set", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      process.env[KEY] = value;
      expect(supabaseEnvBool(KEY)).toBe(true);
    }
  });

  it("is false for the false set and any unrecognized value", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
      process.env[KEY] = value;
      expect(supabaseEnvBool(KEY)).toBe(false);
    }
  });

  it("is false when the env var is absent", () => {
    delete process.env[KEY];
    expect(supabaseEnvBool(KEY)).toBe(false);
  });
});

describe("supabaseEnvBoolWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("falls back to the project value only when the shell var is absent", () => {
    delete process.env[KEY];
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(true);
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(false);
    expect(supabaseEnvBoolWithProjectFallback(KEY, {})).toBe(false);
  });

  it("keeps a false shell override even when the project .env says true", () => {
    process.env[KEY] = "false";
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an empty shell value as present (blocks the project value) and false", () => {
    process.env[KEY] = "";
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an unparsable shell value as present and false (cast.ToBool swallows the error)", () => {
    process.env[KEY] = "banana";
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("keeps a true shell value over a false project value", () => {
    process.env[KEY] = "true";
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(true);
  });

  it("whenUnset: true resolves a key absent from both envs to true (opt-out gate default)", () => {
    delete process.env[KEY];
    expect(supabaseEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(true);
  });

  it("whenUnset: true still yields false for any present non-true value", () => {
    process.env[KEY] = "0";
    expect(supabaseEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(false);
    process.env[KEY] = "";
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }, { whenUnset: true })).toBe(
      false,
    );
    process.env[KEY] = "banana";
    expect(supabaseEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true })).toBe(false);
    delete process.env[KEY];
    expect(supabaseEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }, { whenUnset: true })).toBe(
      false,
    );
  });
});

describe("supabaseEnvStringWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[STRING_KEY];
  });

  it("falls back to the project value only when the shell var is absent", () => {
    delete process.env[STRING_KEY];
    expect(
      supabaseEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" }),
    ).toBe("project-value");
    expect(supabaseEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
  });

  it("keeps the shell value over a project value", () => {
    process.env[STRING_KEY] = "shell-value";
    expect(
      supabaseEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" }),
    ).toBe("shell-value");
  });

  it("treats an empty shell value as present (blocks the project value)", () => {
    process.env[STRING_KEY] = "";
    expect(
      supabaseEnvStringWithProjectFallback(STRING_KEY, { [STRING_KEY]: "project-value" }),
    ).toBe("");
  });

  it("returns an empty string (not undefined) when absent from both", () => {
    delete process.env[STRING_KEY];
    expect(supabaseEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
  });
});
