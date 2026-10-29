import { Effect, Option } from "effect";

import { resolveParentScopedProjectRef } from "./parent-scoped-project-ref.ts";
import { rejectRefShapedRemote, resolveHostedRemote, selectTarget } from "./remote-resolution.ts";
import type { ProjectTargetFlagValues } from "./target-flags.ts";
import { TargetNeedsProjectError } from "./target.errors.ts";

interface ParentProjectTargetOptions {
  /** For a parent-project command such as `branches *`: `--remote` takes a ref, not a branch. */
  readonly parent: true;
}

interface DetailedProjectTargetOptions {
  /** Returns the resolved linked target, with the branch it was found through, not just its ref. */
  readonly detail: true;
}

const selectProject = Effect.fnUntraced(function* (
  flags: ProjectTargetFlagValues,
  options: { readonly valueHint?: string } = {},
) {
  return yield* selectTarget(
    {
      remote: flags.remote,
      projectRef: flags.projectRef,
      local: false,
      linked: false,
    },
    options,
  );
});

const unreachableSelection = (tag: "Local" | "DbUrl") =>
  Effect.die(new Error(`a project-only selector cannot select "${tag}"`));

const resolveHosted = Effect.fn("Target.resolveProject")(function* (
  flags: ProjectTargetFlagValues,
) {
  const { selection } = yield* selectProject(flags);
  switch (selection._tag) {
    case "Local":
    case "DbUrl":
      return yield* unreachableSelection(selection._tag);
    case "Default":
      return yield* resolveHostedRemote({ _tag: "Linked" });
    case "Linked":
    case "Ref":
    case "Branch":
      return yield* resolveHostedRemote(selection);
  }
});

const resolveParent = Effect.fn("Target.resolveProject")(function* (
  flags: ProjectTargetFlagValues,
) {
  const { selection, commandName } = yield* selectProject(flags, { valueHint: "<ref>" });
  switch (selection._tag) {
    case "Branch":
      return yield* new TargetNeedsProjectError({
        message: `${commandName} acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>.`,
      });
    case "Ref":
      return yield* resolveParentScopedProjectRef(Option.some(selection.ref));
    case "Linked":
    case "Default":
      // A branch-name word has one reading here, since `--remote=<branch>` is an error;
      // only a ref-shaped word reads both ways.
      yield* rejectRefShapedRemote();
      return yield* resolveParentScopedProjectRef(Option.none());
    case "Local":
    case "DbUrl":
      return yield* unreachableSelection(selection._tag);
  }
});

/**
 * Resolves the project a hosted-only command acts on: `--remote=<ref|branch>` names one, and a
 * bare `--remote` or no selector falls through to the project-ref chain (`SUPABASE_PROJECT_ID`,
 * the link file, the picker).
 */
export function resolveProjectTarget(
  flags: ProjectTargetFlagValues,
): Effect.Effect<
  string,
  Effect.Error<ReturnType<typeof resolveHosted>>,
  Effect.Services<ReturnType<typeof resolveHosted>>
>;
export function resolveProjectTarget(
  flags: ProjectTargetFlagValues,
  options: ParentProjectTargetOptions,
): ReturnType<typeof resolveParent>;
export function resolveProjectTarget(
  flags: ProjectTargetFlagValues,
  options: DetailedProjectTargetOptions,
): ReturnType<typeof resolveHosted>;
export function resolveProjectTarget(
  flags: ProjectTargetFlagValues,
  options?: ParentProjectTargetOptions | DetailedProjectTargetOptions,
) {
  if (options === undefined) return Effect.map(resolveHosted(flags), (target) => target.ref);
  return "parent" in options ? resolveParent(flags) : resolveHosted(flags);
}
