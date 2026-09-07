/**
 * Unit tests for `legacyConfigProjectConfigTry` — the shared try-helper for
 * `@supabase/config`'s convergence calls (`config.project-config.ts`).
 *
 * Every real call site (`config diff`, `config pull`, `config push`) is
 * covered end to end by its own integration suite; the one branch integration
 * coverage cannot exercise directly is the defect arm, so it gets its own
 * focused test here.
 */

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { ProjectConfigParseError } from "@supabase/config";

import { legacyConfigProjectConfigTry } from "./config.project-config.ts";

describe("legacyConfigProjectConfigTry", () => {
  it.effect("keeps a ProjectConfigParseError as a typed failure", () => {
    const error = new ProjectConfigParseError({ message: "boom", cause: undefined });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigProjectConfigTry(() => {
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
      const result = yield* legacyConfigProjectConfigTry(() => 42);
      expect(result).toBe(42);
    });
  });

  it.effect("dies on any other thrown value", () => {
    return Effect.gen(function* () {
      const exit = yield* legacyConfigProjectConfigTry(() => {
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
