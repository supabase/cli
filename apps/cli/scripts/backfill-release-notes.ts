#!/usr/bin/env bun
// Re-derives a GitHub Release's changelog from its tag's commit using the
// current semantic-release config, regardless of what apps/cli/package.json
// looked like when the tag was cut. Used both as a local debugging tool and
// as the engine behind .github/workflows/backfill-release-notes.yml.
//
// Backfilling an old tag trips semantic-release on several fronts at once: it
// picks the wrong branch from CI env vars, can't read channel notes for
// historical tags, refuses to proceed when the local branch is "behind" the
// real remote, and uses whatever release config existed at the tag's commit.
// The script works around each of those in a temp clone so the original
// workspace stays clean.
//
// Usage:
//   bun apps/cli/scripts/backfill-release-notes.ts --tag v2.99.0-beta.1
//   bun apps/cli/scripts/backfill-release-notes.ts --tag v2.100.1 --apply
//
//   --tag    Required. Release tag to refresh (e.g. v2.99.0-beta.1).
//   --apply  Update the GitHub Release body via `gh release edit`.
//            Without it, raw markdown notes are printed to stdout.
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import semanticRelease from "semantic-release";
import { channelForTag, releaseBranchForTag } from "./release-channels.ts";

class JsonParseFailed extends Data.TaggedError("JsonParseFailed")<{ readonly cause: unknown }> {}

class ShellCommandFailed extends Data.TaggedError("ShellCommandFailed")<{
  readonly cause: unknown;
}> {}

class SemanticReleaseFailed extends Data.TaggedError("SemanticReleaseFailed")<{
  readonly cause: unknown;
}> {}

class LocalReleasePluginOutsideCli extends Data.TaggedError("LocalReleasePluginOutsideCli")<{
  readonly message: string;
}> {}

const shell = <A>(command: () => Promise<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellCommandFailed({ cause }) });

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
/* Native `JSON.parse`, so malformed JSON fails with its own `SyntaxError`. */
const parseJson = (text: string) => JSON.parse(text);
const decodeJson = (text: string) =>
  Effect.try({ try: () => parseJson(text), catch: (cause) => new JsonParseFailed({ cause }) });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodePackageJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
});

function releasePluginSpecifier(plugin: unknown): string | undefined {
  if (typeof plugin === "string") return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === "string") return plugin[0];
  return undefined;
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tag = values.tag;
  if (!tag) {
    yield* Console.error("--tag is required (e.g. --tag v2.99.0-beta.1)");
    return yield* Effect.sync(() => process.exit(2));
  }
  const apply = values.apply ?? false;

  const repoRoot = (yield* shell(() => $`git rev-parse --show-toplevel`.text())).trim();
  const cliDir = path.join(repoRoot, "apps/cli");

  const rootPkg = yield* decodeJson(
    utf8.decode(yield* fs.readFile(path.join(cliDir, "package.json"))),
  );

  const copyLocalReleasePlugins = Effect.fnUntraced(function* (clone: string) {
    const plugins = Array.isArray(rootPkg.release?.plugins) ? rootPkg.release.plugins : [];
    const historicalCliDir = path.join(clone, "apps/cli");

    for (const plugin of plugins) {
      const specifier = releasePluginSpecifier(plugin);
      if (!specifier || path.isAbsolute(specifier) || !specifier.startsWith(".")) continue;

      const sourcePath = path.resolve(cliDir, specifier);
      const relativePath = path.relative(cliDir, sourcePath);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return yield* new LocalReleasePluginOutsideCli({
          message: `Local release plugin must stay inside apps/cli: ${specifier}`,
        });
      }

      const destinationPath = path.join(historicalCliDir, relativePath);
      yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
      yield* fs.copyFile(sourcePath, destinationPath);
    }
  });

  const repoField = rootPkg.repository?.url ?? rootPkg.repository ?? "";
  const repoUrl = `${String(repoField)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")}.git`;
  if (!repoUrl.startsWith("http")) {
    yield* Console.error(
      `Could not derive repository URL from apps/cli/package.json (got: ${repoUrl})`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const tagCheck = yield* shell(() =>
    $`git rev-parse -q --verify refs/tags/${tag}`.cwd(repoRoot).nothrow().quiet(),
  );
  if (tagCheck.exitCode !== 0) {
    yield* Console.error(`Tag ${tag} not found locally. Try: git fetch --tags origin`);
    return yield* Effect.sync(() => process.exit(1));
  }

  const backfill = (work: string) =>
    Effect.gen(function* () {
      const clone = path.join(work, "repo");

      yield* Console.error(`==> Cloning ${repoRoot} -> ${clone}`);
      yield* shell(() => $`git clone --quiet --no-local ${repoRoot} ${clone}`);

      // `git notes add` (used below to seed channel notes) requires a committer
      // identity, which CI runners don't ship in ~/.gitconfig.
      yield* shell(
        () => $`git -C ${clone} config --local user.email backfill-release-notes@supabase.local`,
      );
      yield* shell(() => $`git -C ${clone} config --local user.name backfill-release-notes`);
      // A signing key inherited from a user's global config would also make
      // `git notes add` fail; the temp clone never publishes anything, so disable it.
      yield* shell(() => $`git -C ${clone} config --local commit.gpgsign false`);
      yield* shell(() => $`git -C ${clone} config --local tag.gpgsign false`);

      const originUrl = (yield* shell(() =>
        $`git -C ${repoRoot} remote get-url origin`.text(),
      )).trim();

      // Notes refs aren't fetched by `git clone`. Pull from the source repo first
      // (network-free), then from origin so even tags whose notes haven't been
      // sync'd locally yet are available.
      yield* shell(() =>
        $`git -C ${clone} fetch --no-tags --quiet ${repoRoot} +refs/notes/*:refs/notes/*`
          .nothrow()
          .quiet(),
      );
      yield* shell(() =>
        $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/notes/*:refs/notes/*`
          .nothrow()
          .quiet(),
      );
      // One fetch per branch: git aborts a multi-ref fetch when any named ref is missing, and `next`
      // may not exist. The `v*.x` glob matches zero or more branches without failing.
      for (const branchSpec of ["main", "develop", "next", "v*.x"]) {
        yield* shell(() =>
          $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/heads/${branchSpec}:refs/remotes/origin/${branchSpec}`
            .nothrow()
            .quiet(),
        );
      }

      const sha = (yield* shell(() => $`git -C ${clone} rev-list -n 1 ${tag}`.text())).trim();
      const onMain =
        (yield* shell(() =>
          $`git -C ${clone} merge-base --is-ancestor ${sha} refs/remotes/origin/main`
            .nothrow()
            .quiet(),
        )).exitCode === 0;
      const branch = releaseBranchForTag(tag, onMain);
      if (
        branch !== "main" &&
        branch !== "develop" &&
        branch !== "next" &&
        (yield* shell(() =>
          $`git -C ${clone} rev-parse --verify -q refs/remotes/origin/${branch}`.nothrow().quiet(),
        )).exitCode !== 0
      ) {
        yield* Console.error(`${tag} belongs to ${branch}, but origin/${branch} does not exist.`);
        return yield* Effect.sync(() => process.exit(1));
      }
      // Delete the target tag and any other local tag pointing at the same commit:
      // when a stable and a beta share a commit, semantic-release picks the
      // higher-semver one as lastRelease (which becomes HEAD itself, leaving "no
      // release"). Dropping the co-incident tags falls back to the genuine prior release.
      const coincidentTagsOut = yield* shell(() =>
        $`git -C ${clone} tag --points-at ${sha}`.text(),
      );
      const coincidentTags = coincidentTagsOut
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      for (const ct of coincidentTags) {
        yield* shell(() => $`git -C ${clone} tag -d ${ct}`.quiet().nothrow());
      }
      yield* shell(() => $`git -C ${clone} checkout -B ${branch} ${sha} --quiet`);

      // The clone only carries refs/heads/$BRANCH locally; seed the other
      // configured branches from origin's tracking refs so semantic-release's
      // branch validator sees them. A maintenance branch needs main present to compute its range.
      for (const cfg of ["main", "develop", "next"]) {
        if (cfg === branch) continue;
        const refSha = yield* shell(() =>
          $`git -C ${clone} rev-parse --verify -q refs/remotes/origin/${cfg}`.nothrow().quiet(),
        );
        if (refSha.exitCode === 0) {
          yield* shell(
            () => $`git -C ${clone} update-ref refs/heads/${cfg} ${refSha.text().trim()}`,
          );
        }
      }

      // semantic-release's notes reader returns channels=[null] for any tag
      // missing an annotation, and the prerelease filter drops those tags
      // entirely — walking lastRelease back far enough to drag unrelated commits
      // into the changelog. Seed a channel note for every reachable tag that
      // lacks one, inferring the channel from the tag name.
      const mergedTagsOut = yield* shell(() =>
        $`git -C ${clone} tag --merged HEAD --sort=v:refname`.text(),
      );
      const mergedTags = mergedTagsOut.split("\n").filter((t) => t && t !== tag);
      for (const prevTag of mergedTags) {
        const noteCheck = yield* shell(() =>
          $`git -C ${clone} notes --ref semantic-release show ${prevTag}`.nothrow().quiet(),
        );
        if (noteCheck.exitCode === 0) continue;
        const payload = yield* encodeJson({ channels: [channelForTag(prevTag)] });
        yield* shell(() =>
          $`git -C ${clone} notes --ref semantic-release add -f -m ${payload} ${prevTag}^{commit}`.quiet(),
        );
      }

      // Apply the current release config to the historical checkout, so the notes
      // come out in the right shape regardless of what release config shipped at the tag.
      const clonePkgPath = path.join(clone, "apps/cli/package.json");
      const clonePkg = yield* decodeJson(utf8.decode(yield* fs.readFile(clonePkgPath)));
      clonePkg.release = rootPkg.release;
      yield* fs.writeFileString(clonePkgPath, `${yield* encodePackageJson(clonePkg)}\n`);
      yield* copyLocalReleasePlugins(clone);

      // semantic-release exits with "behind remote" whenever the remote tip
      // differs from HEAD, which it always does when backfilling an old tag. Use
      // git's insteadOf to redirect the GitHub URL to the local clone for this
      // run, while semantic-release still renders commit/PR links against the real URL.
      yield* shell(
        () => $`git -C ${clone} config --local url.file://${clone}.insteadOf ${repoUrl}`,
      );

      yield* Console.error(`==> Re-staged on ${branch} @ ${sha} (without tag ${tag})`);
      yield* Console.error(`==> Running semantic-release --dry-run`);

      // env-ci detects the branch from GITHUB_REF (and friends) even with `noCi:
      // true`, which only bypasses the "not in CI" guard. That can name a branch
      // other than the one the clone's HEAD actually points at, so strip the
      // GitHub Actions detection vars and let env-ci read HEAD directly.
      const childEnv = { ...process.env };
      for (const key of [
        "GITHUB_ACTIONS",
        "GITHUB_REF",
        "GITHUB_REF_NAME",
        "GITHUB_HEAD_REF",
        "GITHUB_BASE_REF",
        "GITHUB_EVENT_NAME",
        "CI",
      ]) {
        delete childEnv[key];
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          semanticRelease(
            { dryRun: true, noCi: true, repositoryUrl: repoUrl },
            {
              cwd: path.join(clone, "apps/cli"),
              env: childEnv,
              stdout: process.stderr,
              stderr: process.stderr,
            },
          ),
        catch: (cause) => new SemanticReleaseFailed({ cause }),
      });

      if (!result || !result.nextRelease) {
        yield* Console.error(`semantic-release did not compute a next release for ${tag}`);
        return yield* Effect.sync(() => process.exit(1));
      }

      const expected = tag.replace(/^v/, "");
      if (result.nextRelease.version !== expected) {
        yield* Console.error(
          `semantic-release computed v${result.nextRelease.version} but expected ${tag}; ` +
            `check channel notes and release config`,
        );
        return yield* Effect.sync(() => process.exit(1));
      }

      const notes = result.nextRelease.notes ?? "";

      if (apply) {
        const notesFile = path.join(work, "notes.md");
        yield* fs.writeFileString(notesFile, notes);
        yield* Console.error(`==> Updating GitHub Release body for ${tag}`);
        yield* shell(() => $`gh release edit ${tag} --notes-file ${notesFile}`);
      } else {
        yield* Effect.sync(() => {
          process.stdout.write(notes);
          if (!notes.endsWith("\n")) process.stdout.write("\n");
        });
      }
    });
  /* A failed removal replaces the run's outcome. */
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const work = yield* fs.makeTempDirectory({ prefix: "backfill-release-notes." });
      const outcome = yield* Effect.exit(restore(backfill(work)));
      yield* fs.remove(work, { recursive: true, force: true });
      return yield* outcome;
    }),
  );
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    Effect.catch((error) => Effect.die(thrownValue(error))),
  ),
);
