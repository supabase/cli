import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import {
  viperEnvBool,
  viperEnvBoolWithProjectFallback,
  viperEnvStringWithProjectFallback,
} from "./viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";
const STRING_KEY = "SUPABASE_TEST_VIPER_STRING";

const run = <A>(key: string, shell: string | undefined, effect: Effect.Effect<A>): A =>
  Effect.runSync(withConfigEnv(shell === undefined ? {} : { [key]: shell }, effect));

describe("viperEnvBool", () => {
  it("is true only for the canonical true set", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(run(KEY, value, viperEnvBool(KEY))).toBe(true);
    }
  });

  it("is false for the false set and any unrecognized value", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
      expect(run(KEY, value, viperEnvBool(KEY))).toBe(false);
    }
  });

  it("is false when the env var is absent", () => {
    expect(run(KEY, undefined, viperEnvBool(KEY))).toBe(false);
  });
});

describe("viperEnvBoolWithProjectFallback", () => {
  it("falls back to the project value only when the shell var is absent", () => {
    expect(run(KEY, undefined, viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }))).toBe(true);
    expect(run(KEY, undefined, viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }))).toBe(
      false,
    );
    expect(run(KEY, undefined, viperEnvBoolWithProjectFallback(KEY, {}))).toBe(false);
  });

  it("keeps a false shell override even when the project .env says true", () => {
    expect(run(KEY, "false", viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }))).toBe(false);
  });

  it("treats an empty shell value as present (blocks the project value) and false", () => {
    expect(run(KEY, "", viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }))).toBe(false);
  });

  it("treats an unparsable shell value as present and false", () => {
    expect(run(KEY, "banana", viperEnvBoolWithProjectFallback(KEY, { [KEY]: "true" }))).toBe(false);
  });

  it("keeps a true shell value over a false project value", () => {
    expect(run(KEY, "true", viperEnvBoolWithProjectFallback(KEY, { [KEY]: "false" }))).toBe(true);
  });

  it("whenUnset: true resolves a key absent from both envs to true (opt-out gate default)", () => {
    expect(run(KEY, undefined, viperEnvBoolWithProjectFallback(KEY, {}, { whenUnset: true }))).toBe(
      true,
    );
  });

  it("whenUnset: true still yields false for any present non-true value", () => {
    const gate = (shell: string | undefined, project: Record<string, string>) =>
      run(KEY, shell, viperEnvBoolWithProjectFallback(KEY, project, { whenUnset: true }));
    expect(gate("0", {})).toBe(false);
    expect(gate("", { [KEY]: "true" })).toBe(false);
    expect(gate("banana", {})).toBe(false);
    expect(gate(undefined, { [KEY]: "false" })).toBe(false);
  });
});

describe("viperEnvStringWithProjectFallback", () => {
  const read = (shell: string | undefined, project: Record<string, string>) =>
    run(STRING_KEY, shell, viperEnvStringWithProjectFallback(STRING_KEY, project));

  it("falls back to the project value only when the shell var is absent", () => {
    expect(read(undefined, { [STRING_KEY]: "project-value" })).toBe("project-value");
    expect(read(undefined, {})).toBe("");
  });

  it("keeps the shell value over a project value", () => {
    expect(read("shell-value", { [STRING_KEY]: "project-value" })).toBe("shell-value");
  });

  it("treats an empty shell value as present (blocks the project value)", () => {
    expect(read("", { [STRING_KEY]: "project-value" })).toBe("");
  });

  it("returns an empty string (not undefined) when absent from both", () => {
    expect(read(undefined, {})).toBe("");
  });
});
