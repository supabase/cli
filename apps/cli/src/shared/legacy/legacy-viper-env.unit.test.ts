import { afterEach, describe, expect, it } from "vitest";

import {
  legacyViperEnvBool,
  legacyViperEnvBoolWithProjectFallback,
  legacyViperEnvStringWithProjectFallback,
} from "./legacy-viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";

describe("legacyViperEnvBool", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("is true only for strconv.ParseBool's true set (viper.GetBool parity)", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      process.env[KEY] = value;
      expect(legacyViperEnvBool(KEY)).toBe(true);
    }
  });

  it("is false for the false set and any unrecognized value", () => {
    // viper casts via strconv.ParseBool and swallows the error to `false`, so
    // `yes`/`on`/`""`/garbage are NOT truthy (unlike some bool parsers).
    for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
      process.env[KEY] = value;
      expect(legacyViperEnvBool(KEY)).toBe(false);
    }
  });

  it("is false when the env var is absent", () => {
    delete process.env[KEY];
    expect(legacyViperEnvBool(KEY)).toBe(false);
  });
});

describe("legacyViperEnvBoolWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  // Go truth table: godotenv.Load only sets project-.env keys ABSENT from the
  // shell env (presence is key-existence, so even an empty shell value blocks
  // the file value), then viper.GetBool reads the merged env
  // (godotenv@v1.5.1/godotenv.go:184-200, apps/cli-go/pkg/config/config.go).

  it("falls back to the project value only when the shell var is absent", () => {
    delete process.env[KEY];
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(true);
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(false);
    expect(legacyViperEnvBoolWithProjectFallback(KEY, {})).toBe(false);
  });

  it("keeps a false shell override even when the project .env says true", () => {
    process.env[KEY] = "false";
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an empty shell value as present (blocks the project value) and false", () => {
    // godotenv's presence check is key-existence in os.Environ(), and viper
    // without AllowEmptyEnv resolves "" to the false default.
    process.env[KEY] = "";
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("treats an unparsable shell value as present and false (cast.ToBool swallows the error)", () => {
    process.env[KEY] = "banana";
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
  });

  it("keeps a true shell value over a false project value", () => {
    process.env[KEY] = "true";
    expect(legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(true);
  });
});

describe("legacyViperEnvStringWithProjectFallback", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns the shell value and ignores the project value when both are set", () => {
    process.env[KEY] = "shell-value";
    expect(legacyViperEnvStringWithProjectFallback(KEY, { [KEY]: "project-value" })).toBe(
      "shell-value",
    );
  });

  it("treats an empty shell value as present (godotenv never overwrites an existing key)", () => {
    process.env[KEY] = "";
    expect(legacyViperEnvStringWithProjectFallback(KEY, { [KEY]: "project-value" })).toBe("");
  });

  it("falls back to the project value when the shell var is absent", () => {
    delete process.env[KEY];
    expect(legacyViperEnvStringWithProjectFallback(KEY, { [KEY]: "project-value" })).toBe(
      "project-value",
    );
  });

  it("returns undefined when the key is absent from both the shell and the project env", () => {
    delete process.env[KEY];
    expect(legacyViperEnvStringWithProjectFallback(KEY, {})).toBeUndefined();
  });
});
