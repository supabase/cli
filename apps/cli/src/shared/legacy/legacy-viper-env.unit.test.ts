import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import {
  makeLegacyViperEnvLayer,
  legacyViperEnvBool,
  legacyViperEnvBoolWithProjectFallback,
  legacyViperEnvEntries,
  legacyViperEnvStringWithProjectFallback,
} from "./legacy-viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";
const STRING_KEY = "SUPABASE_TEST_VIPER_STRING";
const PRIVATE_KEY_PREFIX = "DOTENV_PRIVATE_KEY";

const withEnv = (env: Record<string, string>) =>
  makeLegacyViperEnvLayer(ConfigProvider.fromEnv({ env, preserveEmptyStrings: true }));

describe("legacyViperEnvBool", () => {
  it.live("is true only for strconv.ParseBool's true set (viper.GetBool parity)", () =>
    Effect.gen(function* () {
      for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
        expect(yield* legacyViperEnvBool(KEY).pipe(Effect.provide(withEnv({ [KEY]: value })))).toBe(
          true,
        );
      }
    }),
  );

  it.live("is false for the false set and any unrecognized value", () =>
    Effect.gen(function* () {
      for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
        expect(yield* legacyViperEnvBool(KEY).pipe(Effect.provide(withEnv({ [KEY]: value })))).toBe(
          false,
        );
      }
    }),
  );

  it.live("is false when the env var is absent", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBool(KEY)).toBe(false);
    }).pipe(Effect.provide(withEnv({}))),
  );
});

describe("legacyViperEnvEntries", () => {
  it.live("returns every shell entry with the requested prefix", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvEntries(PRIVATE_KEY_PREFIX)).toEqual({
        DOTENV_PRIVATE_KEY: "base",
        DOTENV_PRIVATE_KEY_PRODUCTION: "production",
        DOTENV_PRIVATE_KEY_STAGING: "staging",
      });
    }).pipe(
      Effect.provide(
        withEnv({
          DOTENV_PRIVATE_KEY: "base",
          DOTENV_PRIVATE_KEY_PRODUCTION: "production",
          DOTENV_PRIVATE_KEY_STAGING: "staging",
          DOTENV_PRIVATE_KEYX: "not-a-match",
          OTHER: "ignored",
        }),
      ),
    ),
  );
});

describe("legacyViperEnvBoolWithProjectFallback", () => {
  it.live("falls back to the project value only when the shell var is absent", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(true);
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(false);
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, {})).toBe(false);
    }).pipe(Effect.provide(withEnv({}))),
  );

  it.live("keeps a false shell override even when the project .env says true", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
    }).pipe(Effect.provide(withEnv({ [KEY]: "false" }))),
  );

  it.live("treats an empty shell value as present and false", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
    }).pipe(Effect.provide(withEnv({ [KEY]: "" }))),
  );

  it.live("treats an unparsable shell value as present and false", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" })).toBe(false);
    }).pipe(Effect.provide(withEnv({ [KEY]: "banana" }))),
  );

  it.live("keeps a true shell value over a false project value", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" })).toBe(true);
    }).pipe(Effect.provide(withEnv({ [KEY]: "true" }))),
  );
});

describe("legacyViperEnvStringWithProjectFallback", () => {
  it.live("falls back to the project value only when the shell var is absent", () =>
    Effect.gen(function* () {
      expect(
        yield* legacyViperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }),
      ).toBe("project-value");
      expect(yield* legacyViperEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
    }).pipe(Effect.provide(withEnv({}))),
  );

  it.live("keeps the shell value over a project value", () =>
    Effect.gen(function* () {
      expect(
        yield* legacyViperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }),
      ).toBe("shell-value");
    }).pipe(Effect.provide(withEnv({ [STRING_KEY]: "shell-value" }))),
  );

  it.live("treats an empty shell value as present and blocks the project value", () =>
    Effect.gen(function* () {
      expect(
        yield* legacyViperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }),
      ).toBe("");
    }).pipe(Effect.provide(withEnv({ [STRING_KEY]: "" }))),
  );

  it.live("returns an empty string when absent from both", () =>
    Effect.gen(function* () {
      expect(yield* legacyViperEnvStringWithProjectFallback(STRING_KEY, {})).toBe("");
    }).pipe(Effect.provide(withEnv({}))),
  );
});
