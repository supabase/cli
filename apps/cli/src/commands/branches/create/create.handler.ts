import { Effect, FileSystem, Option, Path } from "effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../../config/project-link-state.service.ts";
import { Output } from "../../../output/output.service.ts";
import { formatTableRow, outputTable } from "../../../output/table.ts";
import { formatUtcDate, formatUtcTime } from "../../../output/time.ts";
import { RuntimeInfo } from "../../../runtime/runtime-info.service.ts";
import type { CreateFlags } from "./create.command.ts";
import { BranchAlreadyExistsError, NoBranchNameError } from "../errors.ts";

const detectGitBranch: Effect.Effect<
  Option.Option<string>,
  never,
  RuntimeInfo | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const githubHeadRef = process.env.GITHUB_HEAD_REF;
  if (githubHeadRef) {
    return Option.some(githubHeadRef);
  }

  const runtimeInfo = yield* RuntimeInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let dir = path.resolve(runtimeInfo.cwd);
  const root = path.parse(dir).root;

  while (true) {
    const headPath = path.join(dir, ".git", "HEAD");
    const content = yield* fs.readFileString(headPath).pipe(Effect.option);
    if (Option.isSome(content)) {
      const match = content.value.trim().match(/^ref: refs\/heads\/(.+)$/);
      return match?.[1] !== undefined ? Option.some(match[1]) : Option.none<string>();
    }
    if (dir === root) {
      return Option.none<string>();
    }
    dir = path.dirname(dir);
  }
});

const resolveBranchName = Effect.fnUntraced(function* (nameOpt: Option.Option<string>) {
  if (Option.isSome(nameOpt)) {
    return { branchName: nameOpt.value, gitBranch: Option.none<string>() };
  }

  const output = yield* Output;
  const maybeGitBranch = yield* detectGitBranch;

  if (Option.isNone(maybeGitBranch)) {
    return yield* Effect.fail(
      new NoBranchNameError({
        detail: "No branch name provided and no git branch detected.",
        suggestion: "Provide a branch name: `supabase branches create <name>`",
      }),
    );
  }

  const gitBranch = maybeGitBranch.value;

  if (!output.interactive) {
    // Non-interactive mode: auto-use the detected git branch without prompting
    return { branchName: gitBranch, gitBranch: Option.some(gitBranch) };
  }

  const confirmed = yield* output.promptConfirm(`Create branch named "${gitBranch}"?`).pipe(
    Effect.mapError(
      () =>
        new NoBranchNameError({
          detail: "Cannot prompt for branch name in non-interactive mode.",
          suggestion: "Provide a branch name: `supabase branches create <name>`",
        }),
    ),
  );

  if (!confirmed) {
    return yield* Effect.fail(
      new NoBranchNameError({
        detail: "Branch creation cancelled.",
        suggestion: "Provide a branch name: `supabase branches create <name>`",
      }),
    );
  }

  return { branchName: gitBranch, gitBranch: Option.some(gitBranch) };
});

const BRANCH_HEADERS = ["ID", "NAME", "DEFAULT", "GIT BRANCH", "STATUS", "CREATED AT (UTC)"];

export const create = Effect.fn("branches.create")(function* (flags: CreateFlags) {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;
  const api = yield* PlatformApi;

  yield* output.intro("Create branch");

  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return yield* Effect.fail(
      new ProjectNotLinkedError({
        detail: "No project is linked in this directory.",
        suggestion: "Run `supabase link` first.",
      }),
    );
  }

  const { project } = maybeLinkState.value;

  const { branchName, gitBranch } = yield* resolveBranchName(flags.name);

  const desiredInstanceSize = Option.getOrUndefined(flags.size);

  const creating = yield* output.task("Creating branch...");

  const apiEffect = api.v1
    .createABranch({
      ref: project.ref,
      branch_name: branchName,
      ...(Option.isSome(gitBranch) ? { git_branch: gitBranch.value } : undefined),
      ...(Option.isSome(flags.region) ? { region: flags.region.value } : undefined),
      ...(desiredInstanceSize !== undefined
        ? { desired_instance_size: desiredInstanceSize }
        : undefined),
      ...(flags.persistent ? { persistent: flags.persistent } : undefined),
      ...(flags.withData ? { with_data: flags.withData } : undefined),
      ...(Option.isSome(flags.notifyUrl) ? { notify_url: flags.notifyUrl.value } : undefined),
    })
    .pipe(Effect.tapError(() => creating.fail()));

  const branch = yield* apiEffect.pipe(
    Effect.mapError((err) => {
      if (err._tag === "HttpClientError" && err.response?.status === 409) {
        const suggestion = Option.isSome(gitBranch)
          ? `Pass a different name with \`supabase branches create <name>\`.`
          : `Choose a different name or delete the existing branch first.`;
        return new BranchAlreadyExistsError({
          detail: `A branch named "${branchName}" already exists.`,
          suggestion,
        });
      }
      return err;
    }),
  );

  yield* creating.clear();

  if (flags.switchAfter) {
    yield* projectLinkState.setActiveBranch({
      ref: branch.project_ref,
      name: branch.name,
      is_default: branch.is_default,
    });
  }

  if (output.format !== "text") {
    yield* output.success("Branch created", { ...branch });
    return;
  }

  yield* outputTable(
    BRANCH_HEADERS,
    [branch],
    (branch) => [
      branch.project_ref,
      branch.name,
      branch.is_default ? "true" : "false",
      branch.git_branch ?? "",
      branch.status,
      formatUtcDate(branch.created_at),
    ],
    (cells, widths, branch) => {
      const timeIndent = widths.slice(0, -1).reduce((sum, w) => sum + w + 2, 0);
      return (
        formatTableRow(cells, widths) +
        "\n" +
        " ".repeat(timeIndent) +
        formatUtcTime(branch.created_at)
      );
    },
  );

  yield* output.outro(
    flags.switchAfter
      ? `Branch "${branch.name}" created and set as active.`
      : `Branch "${branch.name}" created. Run \`supabase branches switch ${branch.name}\` to switch to it.`,
  );
});
