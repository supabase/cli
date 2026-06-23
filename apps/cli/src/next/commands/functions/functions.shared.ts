import { Effect, Option } from "effect";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../config/project-link-state.service.ts";

export const resolveProjectRef = Effect.fnUntraced(function* (projectRef: Option.Option<string>) {
  if (Option.isSome(projectRef)) {
    return projectRef.value;
  }

  const projectLinkState = yield* ProjectLinkState;
  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return yield* Effect.fail(
      new ProjectNotLinkedError({
        detail: "No project is linked in this directory.",
        suggestion: "Run `supabase link` first or pass `--project-ref`.",
      }),
    );
  }

  return maybeLinkState.value.project.ref;
});
