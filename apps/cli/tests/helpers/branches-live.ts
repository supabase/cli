import { Data, Effect } from "effect";

import {
  awaitLiveBranch,
  awaitLiveBranchesRemoved,
  type LiveFixtures,
  type LiveProject,
  removeLiveBranch,
} from "./live.ts";

/** Typed live failures; `message` is a field so vitest can serialize the error. */
class BranchesLiveError extends Data.TaggedError("BranchesLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const liveFailure = (error: unknown): BranchesLiveError =>
  new BranchesLiveError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

export function awaitBranch(cli: LiveFixtures["cli"], project: LiveProject, branch: string) {
  return Effect.tryPromise({
    try: () => awaitLiveBranch(cli, project, branch),
    catch: liveFailure,
  });
}

export function awaitBranchesRemoved(cli: LiveFixtures["cli"], project: LiveProject) {
  return Effect.tryPromise({
    try: () => awaitLiveBranchesRemoved(cli, project),
    catch: liveFailure,
  });
}

export function removeBranch(cli: LiveFixtures["cli"], project: LiveProject, branch: string) {
  return Effect.tryPromise({
    try: () => removeLiveBranch(cli, project, branch),
    catch: liveFailure,
  });
}
