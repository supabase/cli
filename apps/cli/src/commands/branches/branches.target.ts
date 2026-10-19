import { Effect, Option } from "effect";

import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";

import { block } from "../../command-internal/command-permissions/model.ts";
import { resolveParentScopedProjectRef } from "../../command-internal/parent-project-ref.ts";
import { selectProject } from "../../command-internal/target/project-selection.ts";
import type { ProjectTargetInput } from "../../command-internal/target/resolve-project-target.ts";
import { TargetNeedsProjectError } from "../../command-internal/target/target.errors.ts";

/**
 * The parent project a `branches` command acts on: `--remote=<ref>` names one, and a bare
 * `--remote` or no selector falls through to the linked parent. The branch itself is an argument,
 * so a branch name is no valid `--remote` value here.
 */
export const resolveBranchesParent = Effect.fn("branches.resolveParent")(function* (
  input: ProjectTargetInput,
) {
  const { selection, commandName } = yield* selectProject(input);
  switch (selection.explicit) {
    case "branch":
      return yield* new TargetNeedsProjectError({
        message: `${commandName} acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>.`,
      });
    case "linked":
      return yield* resolveParentScopedProjectRef(selection.ref);
    case undefined:
      return yield* resolveParentScopedProjectRef(Option.none());
    case "local":
    case "db-url":
      return yield* Effect.die(
        new Error(`a project-only selector cannot select "${selection.explicit}"`),
      );
  }
});

/** `--project-ref` is safe to report only when ref-shaped; a branch-shaped value is a user-chosen name. */
export const branchesSafeFlags = (flags: { readonly projectRef: Option.Option<string> }) =>
  Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
    ? ["project-ref"]
    : [];

/** `--remote` only picks the parent project; it never changes which operations a branches command calls. */
export const branchesParentTarget = block("branches-parent-target", [], ["remote"]);
