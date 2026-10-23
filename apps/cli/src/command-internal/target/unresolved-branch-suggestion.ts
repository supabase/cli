import { Effect } from "effect";

import {
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkParentRefInvalidError,
} from "./branch-resolution.errors.ts";

/** Adds `suggestion` to a branch lookup that found no such branch, or had no usable link to search. */
export const withUnresolvedBranchSuggestion =
  (suggestion: string) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | LinkBranchNotFoundError | LinkBranchNotLinkedError | LinkParentRefInvalidError,
    R
  > =>
    Effect.mapError(self, (error) => {
      if (error instanceof LinkBranchNotFoundError) {
        return new LinkBranchNotFoundError({ message: error.message, suggestion });
      }
      if (error instanceof LinkBranchNotLinkedError) {
        return new LinkBranchNotLinkedError({ message: error.message, suggestion });
      }
      if (error instanceof LinkParentRefInvalidError) {
        return new LinkParentRefInvalidError({ message: error.message, suggestion });
      }
      return error;
    });
