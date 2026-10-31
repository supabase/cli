/**
 * Publishes files to another repository through a pull request: clones it, writes on a reused or
 * new branch, pushes when the staged diff is non-empty, and ensures a PR exists while the branch
 * differs from base.
 */
import { $ } from "bun";
import { Console, Data, Effect, FileSystem } from "effect";

class ShellCommandFailed extends Data.TaggedError("ShellCommandFailed")<{
  readonly cause: unknown;
}> {}

class JsonFailed extends Data.TaggedError("JsonFailed")<{ readonly cause: unknown }> {}

export const shell = <A>(command: () => Promise<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellCommandFailed({ cause }) });

/* Plain `JSON` keeps the engine's own error for a cyclic value or malformed `gh` output,
   which a `Schema` codec would replace with its issue text. */
export const json = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new JsonFailed({ cause }) });

function ownPullsOf(existing: string, repo: string) {
  const openPulls: Array<{ headRepositoryOwner?: { login?: string } }> = JSON.parse(existing);
  return openPulls.filter(
    (pull) => pull.headRepositoryOwner?.login?.toLowerCase() === repo.split("/")[0]?.toLowerCase(),
  );
}

export interface PublishPullRequestOptions<E, R> {
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  /** Repo-relative file or directory that `write` changes; it is staged and diffed against base. */
  readonly stagedPath: string;
  readonly write: (checkoutDir: string) => Effect.Effect<void, E, R>;
  readonly commitMessage: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
  /** Arms `gh pr merge --auto --squash` on the open pull request, new or reused. */
  readonly autoMerge: boolean;
}

export const publishPullRequest = <E, R>({
  repo,
  base,
  branch,
  stagedPath,
  write,
  commitMessage,
  pullRequestTitle,
  pullRequestBody,
  autoMerge,
}: PublishPullRequestOptions<E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // `--depth 1` suffices: an existing branch is fetched at its tip and the new content lands as
    // one commit on top, so commits pushed onto an open PR survive later releases.
    const publish = (tmpDir: string) =>
      Effect.gen(function* () {
        yield* shell(
          () =>
            $`git clone --quiet --depth 1 --branch ${base} https://github.com/${repo}.git ${tmpDir}`,
        );

        const remoteBranch = yield* shell(() =>
          $`git -C ${tmpDir} fetch --quiet --depth 1 origin ${branch}`.nothrow().quiet(),
        );
        if (remoteBranch.exitCode === 0) {
          yield* shell(() => $`git -C ${tmpDir} checkout --quiet -B ${branch} FETCH_HEAD`);
        } else {
          yield* shell(() => $`git -C ${tmpDir} checkout --quiet -B ${branch}`);
        }

        yield* write(tmpDir);

        yield* shell(() => $`git -C ${tmpDir} add ${stagedPath}`);
        const unchanged = yield* shell(() =>
          $`git -C ${tmpDir} diff --quiet --cached -- ${stagedPath}`.nothrow().quiet(),
        );
        if (unchanged.exitCode === 0) {
          yield* Console.log(
            remoteBranch.exitCode === 0
              ? `${stagedPath} is already up to date on ${branch}`
              : `${stagedPath} is already up to date in ${repo}`,
          );
        } else {
          yield* shell(
            () =>
              $`git -C ${tmpDir} -c ${"user.name=github-actions[bot]"} -c ${"user.email=41898282+github-actions[bot]@users.noreply.github.com"} commit --quiet -m ${commitMessage}`,
          );
          yield* shell(() => $`git -C ${tmpDir} push --quiet origin ${branch}`);
          yield* Console.log(`Pushed ${branch} to ${repo}`);
        }

        const unpublished = yield* shell(() =>
          $`git -C ${tmpDir} diff --quiet origin/${base} HEAD -- ${stagedPath}`.nothrow().quiet(),
        );
        if (unpublished.exitCode === 1) {
          const existing = yield* shell(() =>
            $`gh pr list --repo ${repo} --head ${branch} --base ${base} --state open --json number,headRepositoryOwner`
              .cwd(tmpDir)
              .text(),
          );
          const ownPulls = yield* json(() => ownPullsOf(existing, repo));
          if (ownPulls.length > 0) {
            yield* Console.log(`Reusing the open PR for ${branch}`);
          } else {
            yield* shell(() =>
              $`gh pr create --repo ${repo} --title ${pullRequestTitle} --body ${pullRequestBody} --base ${base} --head ${branch}`.cwd(
                tmpDir,
              ),
            );
            yield* Console.log(`Opened a pull request against ${repo}`);
          }
          if (autoMerge) {
            yield* shell(() => $`gh pr merge ${branch} --repo ${repo} --auto --squash`.cwd(tmpDir));
            yield* Console.log(`Armed auto-merge for ${branch}`);
          }
        }
      });

    /* A failed removal replaces the run's outcome. */
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "supabase-publish-" });
        const outcome = yield* Effect.exit(restore(publish(tmpDir)));
        yield* fs.remove(tmpDir, { recursive: true, force: true });
        return yield* outcome;
      }),
    );
  });
