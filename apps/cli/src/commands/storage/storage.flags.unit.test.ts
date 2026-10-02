import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { assertStorageTargetsExclusive } from "./storage.flags.ts";

describe("assertStorageTargetsExclusive", () => {
  it.effect("rejects passing both --linked and --local (byte-exact cobra message)", () =>
    Effect.gen(function* () {
      const exit = yield* assertStorageTargetsExclusive([
        "storage",
        "--linked",
        "--local",
        "ls",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "if any flags in the group [linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }),
  );

  it.effect("accepts only --local", () =>
    Effect.gen(function* () {
      const exit = yield* assertStorageTargetsExclusive(["storage", "--local", "ls"]).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("accepts neither flag", () =>
    Effect.gen(function* () {
      const exit = yield* assertStorageTargetsExclusive(["storage", "ls"]).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});
