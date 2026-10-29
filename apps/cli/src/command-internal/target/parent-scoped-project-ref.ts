import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { announceTarget } from "../../shared/output/command-target.service.ts";
import { readCachedLinkedProject, resolveLinkedParentRef } from "../parent-project-ref.ts";
import { listLinkedParentBranches, type ResolvedParent } from "./branch-resolution.ts";
import { describeLinkedTarget } from "./target-identity.ts";

/** The cache outlives a re-link, so it stands only while it lists the linked project. */
const checkedParentRef = Effect.fnUntraced(function* (parent: ResolvedParent) {
  if (parent.linkedRef === undefined) return parent.ref;
  const { parentRef } = yield* listLinkedParentBranches(parent).pipe(
    Effect.orElseSucceed(() => ({ parentRef: parent.ref })),
  );
  yield* Effect.annotateCurrentSpan("parent_project_ref.cache_stale", parentRef !== parent.ref);
  return parentRef;
});

/**
 * The project a `branches` command acts on: the flag, else the linked parent, because branch
 * management endpoints answer 403 for a branch's own ref.
 */
export const resolveParentScopedProjectRef = Effect.fn("ParentProjectRef.resolve")(function* (
  flagValue: Option.Option<string>,
) {
  const resolver = yield* ProjectRefResolver;

  if (Option.isSome(flagValue) && flagValue.value.length > 0) {
    yield* Effect.annotateCurrentSpan("parent_project_ref.source", "flag");
    return yield* resolver.resolve(flagValue);
  }

  const parent = yield* resolveLinkedParentRef();
  yield* Effect.annotateCurrentSpan("parent_project_ref.linked_parent", parent.kind);
  if (parent.kind === "resolved") {
    yield* Effect.annotateCurrentSpan("parent_project_ref.source", "linked_parent");
    const ref = yield* checkedParentRef(parent);
    const cliSettings = yield* CommandSettings;
    const cache = yield* readCachedLinkedProject(
      yield* FileSystem.FileSystem,
      yield* Path.Path,
      cliSettings.workdir,
    );
    yield* announceTarget(describeLinkedTarget({ ref, cache }));
    return ref;
  }

  yield* Effect.annotateCurrentSpan("parent_project_ref.source", "resolver");
  return yield* resolver.resolve(Option.none());
});
