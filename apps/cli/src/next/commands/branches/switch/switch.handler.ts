import { findStack } from "@supabase/stack/effect";
import { Effect, Option } from "effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../../config/project-link-state.service.ts";
import { NonInteractiveError } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { BranchNotFoundError } from "../errors.ts";

export const switchBranch = Effect.fn("branches.switch")(function* (opts: {
  name: Option.Option<string>;
}) {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;
  const api = yield* PlatformApi;
  const cliProjectHome = yield* CliProjectHome;

  yield* output.intro("Switch branch");

  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return yield* Effect.fail(
      new ProjectNotLinkedError({
        detail: "No project is linked in this directory.",
        suggestion: "Run `supabase link` first.",
      }),
    );
  }

  const { project, active_branch } = maybeLinkState.value;
  const fetching = yield* output.task("Fetching branches...");
  const branches = yield* api.v1
    .listAllBranches({ ref: project.ref })
    .pipe(Effect.tapError(() => fetching.fail()));
  yield* fetching.clear();

  let target: (typeof branches)[number];

  if (Option.isSome(opts.name)) {
    const query = opts.name.value;
    const found = branches.find((b) => b.name === query || b.project_ref === query);
    if (found === undefined) {
      return yield* Effect.fail(
        new BranchNotFoundError({
          detail: `Branch '${query}' not found.`,
          suggestion: "Run `supabase branches list` to see available branches.",
        }),
      );
    }
    target = found;
  } else if (output.interactive) {
    const selected = yield* output.promptSelect(
      "Select a branch to switch to",
      branches.map((b) => ({
        value: b.project_ref,
        label: b.name,
        hint: b.project_ref,
      })),
    );
    const found = branches.find((b) => b.project_ref === selected);
    if (found === undefined) {
      return yield* Effect.fail(
        new BranchNotFoundError({
          detail: `Selected branch could not be resolved.`,
          suggestion: "Run `supabase branches list` to see available branches.",
        }),
      );
    }
    target = found;
  } else {
    return yield* Effect.fail(
      new NonInteractiveError({
        detail: "No branch name provided.",
        suggestion: "Run `supabase branches switch <name>` or use an interactive terminal.",
      }),
    );
  }

  if (target.project_ref === active_branch.ref) {
    yield* output.outro(`Already on branch '${target.name}'.`);
    return;
  }

  // Branch switching updates the linked project state. A running local stack
  // remains untouched; users can restart it explicitly with `supabase start`.
  const descriptor = yield* findStack({ projectRoot: cliProjectHome.projectRoot });
  if (
    Option.isSome(descriptor) &&
    descriptor.value.desiredLifecycle === "running" &&
    output.format === "text"
  ) {
    yield* output.info(
      "The local stack is running. Restart it with `supabase start` to apply the new branch.",
    );
  }

  yield* projectLinkState.setActiveBranch({
    ref: target.project_ref,
    name: target.name,
    is_default: target.is_default,
  });

  if (output.format !== "text") {
    yield* output.success("Switched", {
      branch: {
        ref: target.project_ref,
        name: target.name,
        is_default: target.is_default,
      },
    });
  } else {
    yield* output.outro(`Switched to branch '${target.name}'.`);
  }
});
