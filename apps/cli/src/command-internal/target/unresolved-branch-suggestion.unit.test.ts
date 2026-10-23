import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  LinkBranchListNetworkError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkParentRefInvalidError,
} from "./branch-resolution.errors.ts";
import { withUnresolvedBranchSuggestion } from "./unresolved-branch-suggestion.ts";

const suggestion = "Try --from=local.";

describe("withUnresolvedBranchSuggestion", () => {
  it.each([
    new LinkBranchNotFoundError({ message: "not found" }),
    new LinkBranchNotLinkedError({ message: "not linked" }),
    new LinkParentRefInvalidError({ message: "bad link" }),
  ])("adds the suggestion to $_tag and keeps its message", async (error) => {
    const failure = await Effect.runPromise(
      Effect.flip(Effect.fail(error).pipe(withUnresolvedBranchSuggestion(suggestion))),
    );
    expect(failure).toMatchObject({ _tag: error._tag, message: error.message, suggestion });
  });

  it("leaves other failures untouched", async () => {
    const error = new LinkBranchListNetworkError({ message: "offline" });
    const failure = await Effect.runPromise(
      Effect.flip(Effect.fail(error).pipe(withUnresolvedBranchSuggestion(suggestion))),
    );
    expect(failure).toBe(error);
  });
});
