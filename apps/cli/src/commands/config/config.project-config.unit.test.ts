/**
 * Unit tests for `configProjectConfigTry`. Real call sites are covered by their own
 * integration suites; the defect arm isn't reachable there, so it gets a focused test here.
 */

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { ProjectConfigParseError } from "@supabase/config";

import { configProjectConfigTry } from "./config.project-config.ts";

describe("configProjectConfigTry", () => {
  it.effect("keeps a ProjectConfigParseError as a typed failure", () => {
    const error = new ProjectConfigParseError({ message: "boom", cause: undefined });
    return Effect.gen(function* () {
      const exit = yield* configProjectConfigTry(() => {
        throw error;
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const fail = exit.cause.reasons.find(Cause.isFailReason);
        expect(fail?.error).toBe(error);
      }
    });
  });

  it.effect("succeeds with the thunk's value when it does not throw", () => {
    return Effect.gen(function* () {
      const result = yield* configProjectConfigTry(() => 42);
      expect(result).toBe(42);
    });
  });

  it.effect("dies on any other thrown value", () => {
    return Effect.gen(function* () {
      const exit = yield* configProjectConfigTry(() => {
        throw new Error("not a ProjectConfigParseError");
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const hasDie = exit.cause.reasons.some(Cause.isDieReason);
        expect(hasDie).toBe(true);
      }
    });
  });
});
