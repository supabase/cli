import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { resolveRequestedRemoteName } from "./resolve-remote-selection.ts";

describe("resolveRequestedRemoteName", () => {
  it.live("returns None when neither --remote nor SUPABASE_REMOTE is set", () => {
    return resolveRequestedRemoteName({
      remoteFlag: Option.none(),
      remoteEnv: undefined,
      conflictingRefFlagExplicit: false,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
    );
  });

  it.live("--remote wins over SUPABASE_REMOTE", () => {
    return resolveRequestedRemoteName({
      remoteFlag: Option.some("staging"),
      remoteEnv: "prod",
      conflictingRefFlagExplicit: false,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual(Option.some("staging"));
        }),
      ),
    );
  });

  it.live("falls back to SUPABASE_REMOTE when --remote is absent", () => {
    return resolveRequestedRemoteName({
      remoteFlag: Option.none(),
      remoteEnv: "prod",
      conflictingRefFlagExplicit: false,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual(Option.some("prod"));
        }),
      ),
    );
  });

  it.live("blank/whitespace-only SUPABASE_REMOTE is treated as unset", () => {
    return resolveRequestedRemoteName({
      remoteFlag: Option.none(),
      remoteEnv: "   ",
      conflictingRefFlagExplicit: false,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
    );
  });

  it.live("fails with RemoteFlagConflictError when combined with an explicit ref flag", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveRequestedRemoteName({
          remoteFlag: Option.some("staging"),
          remoteEnv: undefined,
          conflictingRefFlagExplicit: true,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("does not conflict when no remote was actually requested", () => {
    return resolveRequestedRemoteName({
      remoteFlag: Option.none(),
      remoteEnv: undefined,
      conflictingRefFlagExplicit: true,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
    );
  });
});
