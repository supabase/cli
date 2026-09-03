/**
 * Unit tests for push.handler.ts's exported try-helper.
 *
 * `legacyConfigPush` itself is covered end to end by
 * `push.integration.test.ts`; `legacyPushProjectConfigTry` is the one branch
 * that integration coverage cannot exercise directly (the defect arm), so it
 * gets its own focused test here.
 */

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { ProjectConfigParseError } from "@supabase/config";

import { legacyPushProjectConfigTry } from "./push.handler.ts";

describe("legacyPushProjectConfigTry", () => {
  it.effect("keeps a ProjectConfigParseError as a typed failure", () => {
    const error = new ProjectConfigParseError({ message: "boom", cause: undefined });
    return Effect.gen(function* () {
      const exit = yield* legacyPushProjectConfigTry(() => {
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
      const result = yield* legacyPushProjectConfigTry(() => 42);
      expect(result).toBe(42);
    });
  });

  it.effect("dies on any other thrown value", () => {
    return Effect.gen(function* () {
      const exit = yield* legacyPushProjectConfigTry(() => {
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
