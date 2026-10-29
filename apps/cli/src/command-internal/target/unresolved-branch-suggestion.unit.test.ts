import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  LinkBranchListNetworkError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkParentRefInvalidError,
} from "./branch-resolution.errors.ts";
import { withUnresolvedBranchSuggestion } from "./unresolved-branch-suggestion.ts";

const suggestion = "Try --from=local.";

describe("withUnresolvedBranchSuggestion", () => {
  it.effect.each([
    new LinkBranchNotFoundError({ message: "not found" }),
    new LinkBranchNotLinkedError({ message: "not linked" }),
    new LinkParentRefInvalidError({ message: "bad link" }),
  ])("adds the suggestion to $_tag and keeps its message", (error) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.fail(error).pipe(withUnresolvedBranchSuggestion(suggestion)),
      );
      expect(failure).toMatchObject({ _tag: error._tag, message: error.message, suggestion });
    }),
  );

  it.effect("leaves other failures untouched", () =>
    Effect.gen(function* () {
      const error = new LinkBranchListNetworkError({ message: "offline" });
      const failure = yield* Effect.flip(
        Effect.fail(error).pipe(withUnresolvedBranchSuggestion(suggestion)),
      );
      expect(failure).toBe(error);
    }),
  );
});
