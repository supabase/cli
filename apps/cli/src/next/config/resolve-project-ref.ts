import { Effect, Option } from "effect";
import { resolveRemoteFlag } from "../../shared/cli/global-flags.ts";
import { emitRemoteTarget } from "../../shared/remotes/emit-remote-target.ts";
import { resolveRemoteRef } from "../../shared/remotes/remote-lookup.ts";
import { resolveRequestedRemoteName } from "../../shared/remotes/resolve-remote-selection.ts";
import { ProjectHome } from "./project-home.service.ts";
import { ProjectLinkState, ProjectNotLinkedError } from "./project-link-state.service.ts";

/**
 * Resolves `--remote`/`SUPABASE_REMOTE` ahead of an explicit `--project-ref`,
 * substituting the named remote's ref in its place — the single seam both
 * `resolveProjectRef` and `link`'s own `chooseProjectRef` go through,
 * mirroring the legacy shell's identical central injection in `legacy-project-ref.layer.ts`.
 */
export const resolveEffectiveProjectRefFlag = Effect.fnUntraced(function* (
  projectRef: Option.Option<string>,
) {
  const remoteFlag = yield* resolveRemoteFlag;
  const requested = yield* resolveRequestedRemoteName({
    remoteFlag,
    remoteEnv: process.env["SUPABASE_REMOTE"],
    conflictingRefFlagExplicit: Option.isSome(projectRef) && projectRef.value.trim().length > 0,
  });
  if (Option.isNone(requested)) {
    return projectRef;
  }
  const projectHome = yield* ProjectHome;
  const ref = yield* resolveRemoteRef(projectHome.projectRoot, requested.value);
  yield* emitRemoteTarget(requested.value, ref);
  return Option.some(ref);
});

export const resolveProjectRef = Effect.fnUntraced(function* (projectRef: Option.Option<string>) {
  const effective = yield* resolveEffectiveProjectRefFlag(projectRef);
  if (Option.isSome(effective)) {
    return effective.value;
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
