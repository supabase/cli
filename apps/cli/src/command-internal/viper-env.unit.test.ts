import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";

import {
  viperEnvBool,
  viperEnvBoolWithProjectFallback,
  viperEnvStringWithProjectFallback,
} from "./viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";
const STRING_KEY = "SUPABASE_TEST_VIPER_STRING";

const withShellEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
  );

describe("viperEnvBool", () => {
  it.effect("is true only for strconv.ParseBool's true set (viper.GetBool parity)", () =>
    Effect.gen(function* () {
      for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
        expect(yield* viperEnvBool(KEY).pipe(withShellEnv({ [KEY]: value }))).toBe(true);
      }
    }),
  );

  it.effect("is false for the false set and any unrecognized value", () =>
    Effect.gen(function* () {
      for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
        expect(yield* viperEnvBool(KEY).pipe(withShellEnv({ [KEY]: value }))).toBe(false);
      }
    }),
  );

  it.effect("is false when the env var is absent", () =>
    Effect.gen(function* () {
      expect(yield* viperEnvBool(KEY).pipe(withShellEnv({}))).toBe(false);
    }),
  );
});

describe("viperEnvBoolWithProjectFallback", () => {
  it.effect("falls back to the project value only when the shell var is absent", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }).pipe(withShellEnv({})),
      ).toBe(true);
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }).pipe(withShellEnv({})),
      ).toBe(false);
      expect(yield* viperEnvBoolWithProjectFallback(KEY, {}).pipe(withShellEnv({}))).toBe(false);
    }),
  );

  it.effect("keeps a false shell override even when the project .env says true", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }).pipe(
          withShellEnv({ [KEY]: "false" }),
        ),
      ).toBe(false);
    }),
  );

  it.effect("treats an empty shell value as present (blocks the project value) and false", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }).pipe(
          withShellEnv({ [KEY]: "" }),
        ),
      ).toBe(false);
    }),
  );

  it.effect(
    "treats an unparsable shell value as present and false (cast.ToBool swallows the error)",
    () =>
      Effect.gen(function* () {
        expect(
          yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }).pipe(
            withShellEnv({ [KEY]: "banana" }),
          ),
        ).toBe(false);
      }),
  );

  it.effect("keeps a true shell value over a false project value", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }).pipe(
          withShellEnv({ [KEY]: "true" }),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "whenUnset: true resolves a key absent from both envs to true (opt-out gate default)",
    () =>
      Effect.gen(function* () {
        expect(
          yield* viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true }).pipe(
            withShellEnv({}),
          ),
        ).toBe(true);
      }),
  );

  it.effect("whenUnset: true still yields false for any present non-true value", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true }).pipe(
          withShellEnv({ [KEY]: "0" }),
        ),
      ).toBe(false);
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }, { whenUnset: true }).pipe(
          withShellEnv({ [KEY]: "" }),
        ),
      ).toBe(false);
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true }).pipe(
          withShellEnv({ [KEY]: "banana" }),
        ),
      ).toBe(false);
      expect(
        yield* viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }, { whenUnset: true }).pipe(
          withShellEnv({}),
        ),
      ).toBe(false);
    }),
  );
});

describe("viperEnvStringWithProjectFallback", () => {
  it.effect("falls back to the project value only when the shell var is absent", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }).pipe(withShellEnv({})),
      ).toBe("project-value");
      expect(yield* viperEnvStringWithProjectFallback(STRING_KEY, {}).pipe(withShellEnv({}))).toBe(
        "",
      );
    }),
  );

  it.effect("keeps the shell value over a project value", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }).pipe(withShellEnv({ [STRING_KEY]: "shell-value" })),
      ).toBe("shell-value");
    }),
  );

  it.effect("treats an empty shell value as present (blocks the project value)", () =>
    Effect.gen(function* () {
      expect(
        yield* viperEnvStringWithProjectFallback(STRING_KEY, {
          [STRING_KEY]: "project-value",
        }).pipe(withShellEnv({ [STRING_KEY]: "" })),
      ).toBe("");
    }),
  );

  it.effect(
    "returns an empty string (not undefined) when absent from both, matching viper.GetString",
    () =>
      Effect.gen(function* () {
        expect(
          yield* viperEnvStringWithProjectFallback(STRING_KEY, {}).pipe(withShellEnv({})),
        ).toBe("");
      }),
  );
});
