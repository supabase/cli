import { Effect } from "effect";
import { loadStackConfig } from "./stack-config.ts";
import { readSelectionOrBundled } from "./stack-lock.ts";

/** The artifact pins the project's stack runs: the locked ones, else the bundled ones. */
export const stackProjectSelection = Effect.fn("StackProjectSelection.read")(function* (
  workdir: string,
) {
  const config = yield* loadStackConfig(workdir, { selection: readSelectionOrBundled });
  return config.selection;
});
