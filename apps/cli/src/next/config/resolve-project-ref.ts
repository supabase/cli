import { Effect, Option } from "effect";
import { ProjectLinkState, ProjectNotLinkedError } from "./project-link-state.service.ts";

/**
 * Which project a project-scoped command acts on: an explicit `--project-ref`
 * when given, otherwise the linked project.
 *
 * Lives here rather than beside any one command because more than one command
 * family needs it (`functions`, `workers`), and a command tree may not import
 * another command tree's internals.
 */
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
