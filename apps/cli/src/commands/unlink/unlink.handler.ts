import { Effect, Option } from "effect";
import { formatLinkedProjectLabel } from "../../config/project-link-remote.service.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { Output } from "../../output/output.service.ts";

export const unlink = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;

  yield* output.intro("Unlink local project from Supabase");

  const cachedLinkState = yield* projectLinkState.load;
  yield* projectLinkState.clear;

  if (Option.isNone(cachedLinkState)) {
    yield* output.success("Local project is already unlinked.", {
      project_ref: null,
      cached_link_state: false,
    });
    yield* output.outro("Local checkout was already unlinked.");
    return;
  }

  const clearedProjectRef = cachedLinkState.value.ref;
  const clearedProjectLabel = formatLinkedProjectLabel(cachedLinkState.value);

  yield* output.success("Local project unlinked.", {
    project_ref: clearedProjectRef,
    project_name: cachedLinkState.value.name ?? null,
    cached_link_state: true,
  });
  yield* output.outro(`Unlinked local project from ${clearedProjectLabel}.`);
});
