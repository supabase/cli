/**
 * `supabase compute new --template` — a starter tree fetched with `git` rather than
 * read out of `./stacks/`.
 *
 * The fetch is a depth-1 clone into a temporary directory whose `.git` is then
 * removed, the way `degit` works. Cloning instead of reading a host's archive API
 * is what keeps the flag host-agnostic: anything `git` can clone works, private
 * repositories included, since the user's own credential helper answers for them.
 */

import { Data, Effect, FileSystem, Option, Path, PlatformError } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { collectText } from "../../command-internal/container-cli.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/** What `git` is asked to clone, and which part of the result to copy. */
export interface ComputeTemplateSpec {
  /** A repository URL `git clone` accepts. */
  readonly url: string;
  /** Branch, tag or commit to check out; `undefined` takes the remote's default branch. */
  readonly ref: string | undefined;
  /** Path segments inside the repository, empty for the whole tree. */
  readonly subdir: ReadonlyArray<string>;
  /** `--template` as the user typed it, for output and error messages. */
  readonly display: string;
}

/** `--template` names something this command cannot turn into a repository URL. */
export class InvalidComputeTemplateError extends Data.TaggedError("InvalidComputeTemplateError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `git` is missing, or the clone it ran did not succeed. */
export class ComputeTemplateFetchError extends Data.TaggedError("ComputeTemplateFetchError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * The clone succeeded and does not hold what `--template` named: a subdirectory that
 * isn't there, isn't a directory, or is a link leading out of the repository, or a
 * template tree with no files in it at all.
 */
export class ComputeTemplateContentError extends Data.TaggedError("ComputeTemplateContentError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** A GitHub owner or repository name. */
const GITHUB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A branch, tag or commit. Narrower than git's own ref rules, which allow almost any
 * byte — this has to be safe to hand to `git fetch` as a positional argument.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Something `git clone` treats as a repository location: a scheme-qualified URL, an
 * scp-style `user@host:path` remote, or an absolute local path. A value matching none
 * of these is read as an `<owner>/<repo>` slug instead, which is also what keeps
 * `ext::<command>` — git's arbitrary-command transport — out of the clone.
 */
const CLONEABLE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/\\:@]+@[^\s/\\:]+:|\/|[A-Za-z]:[\\/])/;

const TEMPLATE_SUGGESTION =
  "Pass --template as a GitHub owner/repo slug, optionally with a subdirectory and a #ref " +
  "(supabase/templates/compute/api#main), or as any repository URL git can clone.";

const FETCH_SUGGESTION =
  "Check that git is installed, that the repository and ref exist, and that you can " +
  "clone it from this machine.";

/** A github.com web or clone URL, reduced to the path after the host. */
function githubPath(base: string): string | undefined {
  return /^https?:\/\/(?:www\.)?github\.com\/(.+)$/.exec(base)?.[1];
}

/**
 * Parses `--template` into a clone plan.
 *
 * Accepts a GitHub `<owner>/<repo>` slug with optional trailing subdirectory, a
 * github.com URL including the `/tree/<ref>/<subdir>` form the browser produces, or
 * any other repository URL `git` can clone. A trailing `#<ref>` pins a branch, tag or
 * commit on every form.
 */
export const parseComputeTemplate = Effect.fnUntraced(function* (raw: string) {
  const trimmed = raw.trim();
  const refuse = (why: string) =>
    new InvalidComputeTemplateError({
      detail: `--template "${raw}" ${why}.`,
      suggestion: TEMPLATE_SUGGESTION,
    });

  if (trimmed === "") {
    return yield* refuse("is empty");
  }
  // Otherwise this reaches `git` as an option rather than as a repository.
  if (trimmed.startsWith("-")) {
    return yield* refuse("starts with a hyphen");
  }

  const hash = trimmed.lastIndexOf("#");
  const base = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const hashRef = hash === -1 ? undefined : trimmed.slice(hash + 1);

  if (base === "") {
    return yield* refuse("names a ref with no repository");
  }
  if (hashRef !== undefined && !REF_PATTERN.test(hashRef)) {
    return yield* refuse(`names "${hashRef}" after # which is not a branch, tag or commit`);
  }

  const hosted = githubPath(base);

  if (hosted === undefined && CLONEABLE_URL.test(base)) {
    return {
      url: base,
      ref: hashRef,
      // A subdirectory is only recognized on a GitHub slug or URL, where the repository
      // boundary is part of the syntax; every other URL is a repository in full.
      subdir: [],
      display: trimmed,
    } satisfies ComputeTemplateSpec;
  }

  const segments = (hosted ?? base).replace(/\/+$/, "").split("/");
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/, "");
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
    return yield* refuse("is neither a GitHub owner/repo slug nor a URL git can clone");
  }

  // `/tree/<ref>/<subdir>` is the github.com web URL, so it is read only there — in a
  // bare slug a `tree` segment is an ordinary directory name.
  const rest = segments.slice(2);
  const isWebTree = hosted !== undefined && rest[0] === "tree";
  const treeRef = isWebTree ? rest[1] : undefined;
  const subdir = isWebTree ? rest.slice(2) : rest;

  if (treeRef !== undefined && hashRef !== undefined) {
    return yield* refuse(`names a ref twice, as /tree/${treeRef} and as #${hashRef}`);
  }
  if (isWebTree && treeRef === undefined) {
    return yield* refuse("ends at /tree with no branch, tag or commit after it");
  }
  if (treeRef !== undefined && !REF_PATTERN.test(treeRef)) {
    return yield* refuse(`names "${treeRef}" as a ref, which is not a branch, tag or commit`);
  }
  for (const segment of subdir) {
    // `\` is not a separator here, so a segment carrying one would survive the join
    // and be read as one by the host filesystem.
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      return yield* refuse(
        `names "${subdir.join("/")}", which is not a path inside the repository`,
      );
    }
  }

  return {
    url: `https://github.com/${owner}/${repo}.git`,
    ref: treeRef ?? hashRef,
    subdir,
    display: trimmed,
  } satisfies ComputeTemplateSpec;
});

/**
 * Runs `git`, failing with its stderr when it exits non-zero.
 *
 * `GIT_TERMINAL_PROMPT=0` is set because the alternative is git blocking on a username
 * prompt drawn over the CLI's own output; a private template comes from a credential
 * helper or an SSH key instead.
 */
function runGit(
  spec: ComputeTemplateSpec,
  args: ReadonlyArray<string>,
  cwd?: string,
): Effect.Effect<void, ComputeTemplateFetchError, ChildProcessSpawner> {
  const fail = (why: string) =>
    new ComputeTemplateFetchError({
      detail: `Could not fetch --template "${spec.display}": ${why}`,
      suggestion: FETCH_SUGGESTION,
    });

  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("git", [...args], {
        ...(cwd === undefined ? {} : { cwd }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { GIT_TERMINAL_PROMPT: "0" },
        extendEnv: true,
      }).pipe(Effect.mapError((error) => fail(`git could not be started (${error.message})`)));

      const [exitCode, stderr] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), collectText(handle.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => fail("git did not report an exit status")));

      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* fail(message.length > 0 ? message : `git exited with code ${exitCode}`);
      }
    }),
  );
}

/**
 * Reports a failure reading the tree that was just cloned as a fetch failure: the
 * staged directory is the CLI's own, so the clone is what did not land usably.
 */
const staging = (spec: ComputeTemplateSpec) =>
  Effect.mapError(
    (error: PlatformError.PlatformError) =>
      new ComputeTemplateFetchError({
        detail: `Could not fetch --template "${spec.display}": the clone could not be read (${error.message})`,
        suggestion: FETCH_SUGGESTION,
      }),
  );

/**
 * Clones `spec` into a temporary directory owned by the current scope and returns the
 * directory its files start at.
 *
 * Nothing in the project is touched: the caller copies out of the staged tree, so a
 * fetch that fails for any reason leaves the destination as it found it.
 */
export const stageComputeTemplate = Effect.fnUntraced(function* (spec: ComputeTemplateSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const clone = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-template-" }).pipe(
    Effect.mapError(
      (error) =>
        new ComputeTemplateFetchError({
          detail: `Could not fetch --template "${spec.display}": no temporary directory to clone into (${error.message})`,
          suggestion: FETCH_SUGGESTION,
        }),
    ),
  );

  if (spec.ref === undefined) {
    yield* runGit(spec, [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--quiet",
      "--",
      spec.url,
      clone,
    ]);
  } else {
    // Fetching one ref by name, rather than `clone --branch`, is what makes a commit
    // SHA work: `--branch` accepts only branches and tags.
    yield* runGit(spec, ["init", "--quiet", clone]);
    yield* runGit(spec, ["fetch", "--depth", "1", "--quiet", spec.url, spec.ref], clone);
    yield* runGit(spec, ["checkout", "--quiet", "FETCH_HEAD"], clone);
  }

  // A template is a starting point, not a checkout. Left in place, its history would
  // become the compute directory's own, and `push` would package it.
  yield* fs.remove(path.join(clone, ".git"), { recursive: true, force: true }).pipe(staging(spec));

  const root = spec.subdir.length === 0 ? clone : path.join(clone, ...spec.subdir);
  const refuse = (why: string) =>
    new ComputeTemplateContentError({
      detail: `--template "${spec.display}" ${why}.`,
      suggestion: TEMPLATE_SUGGESTION,
    });

  const canonicalClone = yield* fs.realPath(clone).pipe(staging(spec));
  const canonicalRoot = yield* fs.realPath(root).pipe(Effect.option);
  if (Option.isNone(canonicalRoot)) {
    return yield* refuse(`names ${spec.subdir.join("/")}, which the repository does not have`);
  }

  // The cloned repository decides what `root` resolves to, so a subdirectory that is a
  // symlink could otherwise point the copy at anything on this machine.
  const relative = path.relative(canonicalClone, canonicalRoot.value);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return yield* refuse(
      `names ${spec.subdir.join("/")}, which is a link leading outside the repository`,
    );
  }

  const info = yield* fs.stat(canonicalRoot.value).pipe(staging(spec));
  if (info.type !== "Directory") {
    return yield* refuse(`names ${spec.subdir.join("/")}, which is not a directory`);
  }

  const entries = yield* fs.readDirectory(canonicalRoot.value).pipe(staging(spec));
  if (entries.length === 0) {
    return yield* refuse("holds no files");
  }

  return canonicalRoot.value;
});
