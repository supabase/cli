import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Context, Duration, Effect, FileSystem, Layer, Schedule, type PlatformError } from "effect";
import { claimFileAtomically } from "./atomic-claim.ts";
import { errorCode } from "./error-code.ts";
import { asRaised, failsOnlyWith, failsWith } from "./failure.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { decodeGitCheckoutIdentity } from "./git-identity.ts";
import {
  GIT_CHECKOUT_IDENTITY_VERSION,
  InvalidManagedIdentityError,
  UnsupportedGitWorkspaceError,
  type GitCheckoutIdentity,
  type UnsupportedGitWorkspaceCause,
} from "./model.ts";
import {
  gitCheckoutIdentityPath,
  gitConfigPath,
  gitWorktreeConfigPath,
  ordinaryWorkspaceIdentityPath,
} from "./paths.ts";

const BRANCH_REF_PREFIX = "refs/heads/";
const COMMON_DIRECTORY_FILE = "commondir";
const GIT_ENTRY = ".git";
const GIT_DIRECTORY_LINK_PREFIX = "gitdir:";
const HEAD_FILE = "HEAD";
const PACKED_REFS_FILE = "packed-refs";
const SYMBOLIC_REF_PREFIX = "ref: ";

/** SHA-1 and SHA-256 object ids, the two hashes a `HEAD` can be detached at. */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Entries every git directory has. A workspace that has them at its own top
 * level *is* a git directory — a bare repository, or a `.git` somebody changed
 * into — rather than a checkout that contains one.
 */
const GIT_DIRECTORY_ENTRIES = [HEAD_FILE, "objects", "refs"] as const;

/** The project identity, shared by every checkout of the same repository. */
export const GIT_PROJECT_ID_KEY = "supabase.projectId";

/**
 * The branch context identity, keyed by branch so that git owns its lifecycle:
 * `git branch -m` renames the whole `branch.<name>` section and deleting a
 * branch deletes it, so a context needs no rename or reaper of its own.
 *
 * Subsection names are case-sensitive and may contain `/` and `.`; git splits a
 * key at its first and last dot, so a branch name never has to be escaped.
 */
export const gitBranchContextIdKey = (branch: string): string =>
  `branch.${branch}.supabaseContextId`;

export type GitCheckoutKind = "bare-worktree" | "linked-worktree" | "primary";

export type GitHead =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached"; readonly commit: string }
  | { readonly kind: "unborn"; readonly branch: string };

export interface OrdinaryFolderInspection {
  readonly kind: "ordinary-folder";
  readonly canonicalPath: string;
}

export interface GitCheckoutInspection {
  readonly kind: "git-checkout";
  readonly checkoutKind: GitCheckoutKind;
  readonly canonicalPath: string;
  /** The checkout's top-level working directory: the one holding its `.git`. */
  readonly workspaceRoot: string;
  /** This checkout's own git directory, where its checkout identity lives. */
  readonly gitDirectory: string;
  /** The repository directory shared with every linked worktree. */
  readonly commonDirectory: string;
  readonly head: GitHead;
}

export type WorkspaceInspection = GitCheckoutInspection | OrdinaryFolderInspection;

const failsWithGitWorkspace = failsOnlyWith(UnsupportedGitWorkspaceError);
const failsWithIdentity = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, InvalidManagedIdentityError | UnsupportedGitWorkspaceError, R> =>
  Effect.catch(effect, (error) => {
    if (
      error instanceof InvalidManagedIdentityError ||
      error instanceof UnsupportedGitWorkspaceError
    ) {
      return Effect.fail(error);
    }
    return Effect.die(error);
  });

const unsupported = (
  path: string,
  reason: string,
  workspaceCause: UnsupportedGitWorkspaceCause,
): Effect.Effect<never, UnsupportedGitWorkspaceError> =>
  Effect.fail(new UnsupportedGitWorkspaceError({ path, reason, workspaceCause }));

const platformErrorPath = (error: PlatformError.PlatformError): string | undefined =>
  error.reason._tag === "BadArgument" || typeof error.reason.pathOrDescriptor !== "string"
    ? undefined
    : error.reason.pathOrDescriptor;

const inaccessiblePlatformError = (
  fallbackPath: string,
  error: PlatformError.PlatformError,
): Effect.Effect<never, UnsupportedGitWorkspaceError> => {
  const detail = error.reason.description === undefined ? error.message : error.reason.description;
  return unsupported(
    platformErrorPath(error) ?? fallbackPath,
    `Git metadata is inaccessible (${error.reason._tag}): ${detail}`,
    "metadata-inaccessible",
  );
};

/**
 * A file git may or may not have written. Absence is an answer throughout git's
 * metadata — an unborn branch has no ref file, a primary checkout has no
 * `commondir` — so it is reported as `undefined` rather than as a failure.
 */
const readOptionalFile = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined, PlatformError.PlatformError> =>
  Effect.catch(fs.readFileString(path), (error) =>
    error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
  );

const realPathOrMalformed = (
  fs: FileSystem.FileSystem,
  path: string,
  reason: string,
): Effect.Effect<string, PlatformError.PlatformError | UnsupportedGitWorkspaceError> =>
  Effect.catch(
    fs.realPath(path),
    (error): Effect.Effect<never, PlatformError.PlatformError | UnsupportedGitWorkspaceError> =>
      error.reason._tag === "NotFound"
        ? unsupported(path, reason, "malformed-metadata")
        : Effect.fail(error),
  );

const firstLine = (content: string): string | undefined =>
  content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

/**
 * The git directory a `.git` file points at. Its target may be absolute or
 * relative to the directory holding the `.git` file.
 */
const linkedGitDirectory = (workspaceRoot: string, content: string): string | undefined => {
  const line = firstLine(content);
  if (line === undefined || !line.startsWith(GIT_DIRECTORY_LINK_PREFIX)) {
    return undefined;
  }
  const target = line.slice(GIT_DIRECTORY_LINK_PREFIX.length).trim();
  if (target.length === 0) {
    return undefined;
  }
  return isAbsolute(target) ? resolve(target) : resolve(workspaceRoot, target);
};

const looksLikeGitDirectory = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.map(
    Effect.all(GIT_DIRECTORY_ENTRIES.map((entry) => fs.exists(join(directory, entry)))),
    (found) => found.every((present) => present),
  );

interface GitCheckoutRoot {
  readonly workspaceRoot: string;
  readonly gitDirectory: string;
}

/**
 * Walks up from `canonicalPath` to the checkout that encloses it, or reports
 * that nothing does.
 *
 * The walk is deliberate rather than delegated to `git rev-parse`: discovery
 * happens before anything is claimed and must be able to run without the git
 * binary, and reading the metadata is the whole of it.
 */
const locateGitCheckoutRoot = (
  fs: FileSystem.FileSystem,
  canonicalPath: string,
): Effect.Effect<
  GitCheckoutRoot | undefined,
  PlatformError.PlatformError | UnsupportedGitWorkspaceError
> =>
  Effect.gen(function* () {
    let directory = canonicalPath;
    for (;;) {
      const entry = join(directory, GIT_ENTRY);
      if (yield* fs.exists(entry)) {
        const info = yield* fs.stat(entry);
        if (info.type === "Directory") {
          return { workspaceRoot: directory, gitDirectory: entry };
        }
        const linked = linkedGitDirectory(directory, yield* fs.readFileString(entry));
        if (linked === undefined) {
          return yield* unsupported(
            entry,
            "Cannot read the git directory this .git file points at",
            "malformed-metadata",
          );
        }
        return { workspaceRoot: directory, gitDirectory: linked };
      }
      if (yield* looksLikeGitDirectory(fs, directory)) {
        return yield* unsupported(
          directory,
          "Refusing to inspect a git directory as a workspace",
          "inside-git-directory",
        );
      }
      const parent = dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  });

export const branchRefExists = (
  fs: FileSystem.FileSystem,
  commonDirectory: string,
  ref: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (yield* fs.exists(join(commonDirectory, ...ref.split("/")))) {
      return true;
    }
    const packed = yield* readOptionalFile(fs, join(commonDirectory, PACKED_REFS_FILE));
    return packed === undefined
      ? false
      : packed.split("\n").some((line) => line.trim().split(" ")[1] === ref);
  });

/**
 * A reftable repository's refs live in `reftable/`, and the `HEAD` it keeps for
 * compatibility is a stub naming this branch — a name git's own ref format
 * forbids, so no real branch can collide with it.
 *
 * Such a repository is refused rather than read: reporting it as an unborn branch
 * would give every branch and every detached `HEAD` in it one bogus
 * `branch..invalid` context, and reading the actual refs means implementing
 * another format.
 */
const REFTABLE_HEAD_STUB_BRANCH = ".invalid";
const REFTABLE_UNSUPPORTED_REASON =
  "Refusing a repository whose refs are stored in a reftable, which is not supported yet";

const resolveHead = (
  fs: FileSystem.FileSystem,
  gitDirectory: string,
  commonDirectory: string,
): Effect.Effect<GitHead, PlatformError.PlatformError | UnsupportedGitWorkspaceError> =>
  Effect.gen(function* () {
    const head = (yield* readOptionalFile(fs, join(gitDirectory, HEAD_FILE)))?.trim();
    if (head === undefined || head.length === 0) {
      return yield* unsupported(
        gitDirectory,
        "The checkout has no readable HEAD",
        "malformed-metadata",
      );
    }
    if (head.startsWith(SYMBOLIC_REF_PREFIX)) {
      const ref = head.slice(SYMBOLIC_REF_PREFIX.length).trim();
      // Only the prefix is stripped: a branch name may itself contain `/`.
      const branch = ref.startsWith(BRANCH_REF_PREFIX)
        ? ref.slice(BRANCH_REF_PREFIX.length)
        : undefined;
      if (branch === undefined || branch.length === 0) {
        return yield* unsupported(
          gitDirectory,
          `HEAD does not name a branch under ${ref}`,
          "malformed-metadata",
        );
      }
      // The compat stub of a reftable repository, which is refused by its
      // `extensions.refStorage` before this runs. Checked again here because the
      // stub is the tripwire that cannot be missed: a repository declaring the
      // extension some other way must still never reach a `.invalid` context.
      if (branch === REFTABLE_HEAD_STUB_BRANCH) {
        return yield* unsupported(gitDirectory, REFTABLE_UNSUPPORTED_REASON, "reftable");
      }
      if (
        branch.includes("\\") ||
        branch
          .split("/")
          .some((segment) => segment.length === 0 || segment === "." || segment === "..")
      ) {
        return yield* unsupported(
          gitDirectory,
          "HEAD names a branch with an invalid path segment",
          "malformed-metadata",
        );
      }
      // A branch whose ref does not exist yet is the state a fresh repository
      // starts in, so it names a context even though it has no commit.
      return (yield* branchRefExists(fs, commonDirectory, ref))
        ? { kind: "branch", branch }
        : { kind: "unborn", branch };
    }
    if (OBJECT_ID_PATTERN.test(head)) {
      return { kind: "detached", commit: head };
    }
    return yield* unsupported(
      gitDirectory,
      "HEAD is neither a branch nor an object id",
      "malformed-metadata",
    );
  });

const CONFIG_SECTION_PATTERN = /^\s*\[\s*([\w.-]+)\s*(\]?)/;
const CORE_BARE_PATTERN = /^\s*bare\s*(?:=(.*))?\s*(?:[;#].*)?$/i;
const REF_STORAGE_PATTERN = /^\s*refStorage\s*(?:=(.*))?\s*(?:[;#].*)?$/i;
const WORKTREE_CONFIG_PATTERN = /^\s*worktreeConfig\s*(?:=(.*))?\s*(?:[;#].*)?$/i;
const TRUTHY_CONFIG_VALUES: ReadonlySet<string> = new Set(["1", "on", "true", "yes"]);
const REFTABLE_REF_STORAGE = "reftable";

/**
 * Strips a value's surrounding double quotes, git config's only quoting form for
 * the keys read here, with a minimal unescape of `\"` and `\\` inside — not a
 * full parser, just enough for the bare-word-or-fully-quoted values these keys
 * actually take.
 */
const unquoteConfigValue = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : value;

/**
 * The value `key` holds in `[section]`, or `undefined` when the section does not
 * set it.
 *
 * These are the only config reads on the inspection path, so they stay a line
 * scan: a full config parser would be a liability, and reaching for the git
 * binary here would make read-only discovery depend on it. Every key read this
 * way is one git normally writes itself, as a bare word on its own line — but a
 * hand-edited config may quote the value (`bare = "true"`), which git's own
 * reader still honors, so this scan unquotes a fully-quoted value before
 * comparing it. Comment-stripping still runs first, ahead of unquoting: a quoted
 * value containing `;` or `#` would be mishandled, which is pathological for
 * every key read here since git itself never writes one that way.
 *
 * The two rules that decide which line answers are git's own: `[section "sub"]`
 * is a different section, whose keys say nothing about the plain one, and a key
 * a repository sets more than once is worth whatever it was set to last.
 */
const configValue = (content: string, section: string, key: RegExp): string | undefined => {
  let inSection = false;
  let value: string | undefined;
  for (const line of content.split("\n")) {
    const heading = CONFIG_SECTION_PATTERN.exec(line);
    if (heading !== null) {
      // Section names are case-insensitive, and only a heading that closes right
      // after the name is the plain section: anything else — a subsection, or
      // another section entirely — ends the one being read.
      inSection = heading[2] === "]" && heading[1]?.toLowerCase() === section;
      continue;
    }
    const match = inSection ? key.exec(line) : null;
    if (match !== null) {
      // A variable with no equals sign is `true` in git's config syntax. An
      // explicit empty assignment (`bare =`, including a trailing comment) is
      // different and means false for boolean keys.
      const raw = match[1];
      value = raw === undefined ? "true" : unquoteConfigValue(raw.split(/[;#]/)[0]?.trim() ?? "");
    }
  }
  return value;
};

const isTruthyConfigValue = (value: string | undefined): boolean =>
  value !== undefined && TRUTHY_CONFIG_VALUES.has(value.toLowerCase());

/** What the shared repository's config says about the repository as a whole. */
interface RepositoryConfig {
  /**
   * Whether the repository is bare, which is what separates a worktree of a bare
   * repository from a worktree of an ordinary one.
   */
  readonly bare: boolean;
  /** Whether its refs are stored in a reftable rather than as ref files. */
  readonly reftable: boolean;
}

const readRepositoryConfig = (
  fs: FileSystem.FileSystem,
  commonDirectory: string,
): Effect.Effect<RepositoryConfig, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const shared = (yield* readOptionalFile(fs, gitConfigPath(commonDirectory))) ?? "";
    const reftable =
      configValue(shared, "extensions", REF_STORAGE_PATTERN)?.toLowerCase() ===
      REFTABLE_REF_STORAGE;
    const declaredBare = configValue(shared, "core", CORE_BARE_PATTERN);
    if (declaredBare !== undefined) {
      return { bare: isTruthyConfigValue(declaredBare), reftable };
    }
    // A repository with `extensions.worktreeConfig` enabled keeps `core.bare` in
    // the worktree config instead — git moves it there itself, and enables the
    // extension on its own for `git sparse-checkout set` — so an absent
    // `core.bare` here is not an answer yet. The extension has to be enabled for
    // that file to mean anything, and the one beside the shared config is the
    // repository's own worktree.
    if (!isTruthyConfigValue(configValue(shared, "extensions", WORKTREE_CONFIG_PATTERN))) {
      return { bare: false, reftable };
    }
    const worktree = yield* readOptionalFile(fs, gitWorktreeConfigPath(commonDirectory));
    return {
      bare:
        worktree !== undefined &&
        isTruthyConfigValue(configValue(worktree, "core", CORE_BARE_PATTERN)),
      reftable,
    };
  });

/**
 * Classifies `workspacePath` and resolves the git topology around it, writing
 * nothing.
 *
 * Every mutating operation starts here, and a `status`-style read must reach the
 * same answer without claiming anything, so this must stay free of side effects:
 * identities are ensured separately, by the operations that are allowed to.
 */
export const inspectWorkspace = (
  workspacePath: string,
): Effect.Effect<WorkspaceInspection, UnsupportedGitWorkspaceError, FileSystem.FileSystem> =>
  failsWithGitWorkspace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const canonicalPath = yield* fs.realPath(workspacePath);
      const checkout = yield* locateGitCheckoutRoot(fs, canonicalPath);
      if (checkout === undefined) {
        const ordinary: WorkspaceInspection = { kind: "ordinary-folder", canonicalPath };
        return ordinary;
      }

      const gitDirectory = yield* realPathOrMalformed(
        fs,
        checkout.gitDirectory,
        "Cannot read the git directory this .git file points at",
      );
      // A linked worktree's git directory names the repository it belongs to,
      // relative to itself; a primary checkout's git directory *is* that
      // repository and has no `commondir` at all.
      const commonLink = (yield* readOptionalFile(
        fs,
        join(gitDirectory, COMMON_DIRECTORY_FILE),
      ))?.trim();
      let commonDirectory: string;
      if (commonLink === undefined) {
        commonDirectory = gitDirectory;
      } else if (commonLink.length === 0) {
        return yield* unsupported(
          join(gitDirectory, COMMON_DIRECTORY_FILE),
          "The linked worktree has an empty commondir target",
          "malformed-metadata",
        );
      } else {
        commonDirectory = yield* realPathOrMalformed(
          fs,
          isAbsolute(commonLink) ? commonLink : resolve(gitDirectory, commonLink),
          "Cannot read the common git directory this commondir file points at",
        );
      }

      const repositoryConfig = yield* readRepositoryConfig(fs, commonDirectory);
      if (repositoryConfig.reftable) {
        return yield* unsupported(commonDirectory, REFTABLE_UNSUPPORTED_REASON, "reftable");
      }

      const checkoutKind: GitCheckoutKind =
        gitDirectory === commonDirectory
          ? "primary"
          : repositoryConfig.bare
            ? "bare-worktree"
            : "linked-worktree";

      const inspection: WorkspaceInspection = {
        kind: "git-checkout",
        checkoutKind,
        canonicalPath,
        workspaceRoot: checkout.workspaceRoot,
        gitDirectory,
        commonDirectory,
        head: yield* resolveHead(fs, gitDirectory, commonDirectory),
      };
      return inspection;
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "BadArgument"
          ? Effect.die(error)
          : inaccessiblePlatformError(workspacePath, error),
      ),
    ),
  );

/**
 * Read-only check used when a folder identity marker is carried into a Git
 * checkout. `ls-files --error-unmatch` gives a stable three-way result: exit 0
 * means tracked, exit 1 means absent from the index, and every other status is
 * metadata-inaccessible. The index is never modified.
 */
export const isOrdinaryIdentityMarkerTracked = (
  workspaceRoot: string,
): Effect.Effect<boolean, UnsupportedGitWorkspaceError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolveResult, reject) => {
        execFile(
          "git",
          ["-C", workspaceRoot, "ls-files", "--error-unmatch", "--", ".supabase/identity.json"],
          { encoding: "utf8" },
          (error, _stdout, stderr) => {
            if (error === null) {
              resolveResult(true);
              return;
            }
            if (error.code === 1) {
              resolveResult(false);
              return;
            }
            reject(
              new UnsupportedGitWorkspaceError({
                path: ordinaryWorkspaceIdentityPath(workspaceRoot),
                reason: `Git index metadata is inaccessible (${stderr.trim() || String(error.code)})`,
                workspaceCause: "metadata-inaccessible",
              }),
            );
          },
        );
      }),
    catch: (error: unknown) =>
      error instanceof UnsupportedGitWorkspaceError
        ? error
        : new UnsupportedGitWorkspaceError({
            path: ordinaryWorkspaceIdentityPath(workspaceRoot),
            reason: `Git index metadata is inaccessible (${errorCode(error) ?? String(error)})`,
            workspaceCause: "metadata-inaccessible",
          }),
  });

export interface GitConfigStoreShape {
  /** Every value stored at `key`, in file order; empty when it is not set. */
  readonly getAll: (
    file: string,
    key: string,
  ) => Effect.Effect<ReadonlyArray<string>, UnsupportedGitWorkspaceError>;
  /** Read-only regexp query returning matching keys and values in file order. */
  readonly getRegexp: (
    file: string,
    regexp: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly value: string }>,
    UnsupportedGitWorkspaceError
  >;
  /** Appends a value to `key`, replacing nothing. */
  readonly add: (
    file: string,
    key: string,
    value: string,
  ) => Effect.Effect<void, UnsupportedGitWorkspaceError>;
  /** Collapses `key` to exactly `value`. */
  readonly replace: (
    file: string,
    key: string,
    value: string,
  ) => Effect.Effect<void, UnsupportedGitWorkspaceError>;
  /** Replaces exactly one settled value, refusing when the expected value changed. */
  readonly replaceExpected: (
    file: string,
    key: string,
    expected: string,
    value: string,
  ) => Effect.Effect<
    void,
    UnsupportedGitWorkspaceError | InvalidManagedIdentityError,
    FileSystem.FileSystem
  >;
}

/**
 * The one reader and writer of git config in the managed layer.
 *
 * Writes go through the git binary rather than through this package's own
 * serializer: a hand-written config risks corrupting a user's repository, and
 * git's lock file around the whole read-modify-write is what makes two processes
 * claiming at once safe. Reads go through it too, because a value may be quoted
 * or continued across lines and only git decides what it means.
 */
export class GitConfigStore extends Context.Service<GitConfigStore, GitConfigStoreShape>()(
  "stack/managed/GitConfigStore",
) {}

/** `git config --get-all` exits 1 for a key that is not set, which is an answer. */
const MISSING_KEY_EXIT_CODE = 1;

type GitConfigResult =
  | { readonly kind: "answered"; readonly stdout: string }
  | { readonly kind: "unset" }
  | { readonly kind: "retryable"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string; readonly status?: number };

const runGitConfig = (
  args: ReadonlyArray<string>,
  tolerateUnset: boolean,
  file: string,
): Promise<GitConfigResult> =>
  new Promise((settle) => {
    execFile("git", ["config", ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        settle({ kind: "answered", stdout });
        return;
      }
      // A non-zero exit reports the status as a number; a spawn failure reports an
      // `errno` string instead, and is never something git decided.
      const exitCode = error.code;
      if (tolerateUnset && exitCode === MISSING_KEY_EXIT_CODE && stderr.trim().length === 0) {
        settle({ kind: "unset" });
        return;
      }
      const detail =
        stderr.trim().length > 0
          ? stderr.trim()
          : typeof exitCode === "number"
            ? `git config exited with status ${exitCode}`
            : `git config could not be spawned (${String(exitCode)})`;
      // A lock can disappear between git's refusal and this callback, so the
      // concrete lock-file check is necessarily racy. Git's write statuses 4
      // and 255 are also ambiguous (they can mean a transient lock or a host
      // failure), but bounded retry preserves safe concurrent claims; any
      // terminal result is still reported as generic metadata-inaccessible.
      if (
        (typeof exitCode === "number" && existsSync(`${file}.lock`)) ||
        (typeof exitCode === "number" && (exitCode === 4 || exitCode === 255))
      ) {
        settle({ kind: "retryable", detail });
      } else {
        settle({
          kind: "failed",
          detail,
          status: typeof exitCode === "number" ? exitCode : undefined,
        });
      }
    });
  });

const gitLockRetrySchedule = () =>
  Schedule.exponential(Duration.millis(10)).pipe(Schedule.upTo({ duration: Duration.millis(400) }));

/**
 * `git config` does not wait for another process' config lock — it refuses
 * immediately — so waiting is this store's job. Every claim in a repository with
 * sibling worktrees contends for that lock, so a refusal to wait would make
 * concurrent starts fail rather than serialize. Retry is bounded and only
 * triggered by concrete lock evidence or the two ambiguous git statuses above.
 */
const gitConfig = (
  args: ReadonlyArray<string>,
  tolerateUnset: boolean,
  file: string,
): Effect.Effect<string | undefined, UnsupportedGitWorkspaceError> =>
  Effect.flatMap(
    Effect.catch(
      Effect.retry(
        Effect.flatMap(
          Effect.promise(() => runGitConfig(args, tolerateUnset, file)),
          (result) => (result.kind === "retryable" ? Effect.fail(result) : Effect.succeed(result)),
        ),
        {
          while: (error) => error.kind === "retryable",
          schedule: gitLockRetrySchedule(),
        },
      ),
      (error) =>
        unsupported(file, `Git config is inaccessible (${error.detail})`, "metadata-inaccessible"),
    ),
    (result) => {
      if (result.kind === "answered") return Effect.succeed(result.stdout);
      if (result.kind === "unset") return Effect.succeed(undefined);
      if (result.kind === "failed" && result.status === 128) {
        return unsupported(
          file,
          `Git config is malformed (${result.detail})`,
          "malformed-metadata",
        );
      }
      return unsupported(
        file,
        `Git config is inaccessible (${result.detail})`,
        "metadata-inaccessible",
      );
    },
  );

/** A write refuses rather than tolerating an exit status of its own. */
const gitConfigWrite = (
  args: ReadonlyArray<string>,
  file: string,
): Effect.Effect<void, UnsupportedGitWorkspaceError> => Effect.asVoid(gitConfig(args, false, file));

/**
 * Reads one config key without retrying on the config lock.  Conditional
 * replacement uses this while it owns the lock itself; retrying here would
 * wait on the lock held by this very operation.
 */
const gitConfigOnce = (
  args: ReadonlyArray<string>,
  tolerateUnset: boolean,
  file: string,
): Effect.Effect<string | undefined, UnsupportedGitWorkspaceError> =>
  Effect.flatMap(
    Effect.promise(() => runGitConfig(args, tolerateUnset, file)),
    (result) => {
      if (result.kind === "answered") return Effect.succeed(result.stdout);
      if (result.kind === "unset") return Effect.succeed(undefined);
      if (result.kind === "failed" && result.status === 128) {
        return unsupported(
          file,
          `Git config is malformed (${result.detail})`,
          "malformed-metadata",
        );
      }
      return unsupported(
        file,
        `Git config is inaccessible (${result.kind === "failed" || result.kind === "retryable" ? result.detail : "unknown failure"})`,
        "metadata-inaccessible",
      );
    },
  );

/**
 * Holds Git's real config lock while validating and publishing a replacement.
 * The lock itself is acquired with an exclusive create, then a separate copy
 * is edited by Git and atomically renamed over the config before the lock is
 * released.  This keeps ordinary `git config` writers out of the entire
 * read/modify/publish window.
 */
const gitConfigReplaceExpected = (
  file: string,
  key: string,
  expected: string,
  value: string,
): Effect.Effect<
  void,
  UnsupportedGitWorkspaceError | InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockPath = `${file}.lock`;
    const acquireLock = fs.writeFileString(lockPath, "", { flag: "wx" }).pipe(
      Effect.retry({
        while: (error) => error.reason._tag === "AlreadyExists",
        schedule: gitLockRetrySchedule(),
      }),
    );
    yield* Effect.acquireUseRelease(
      acquireLock,
      () =>
        Effect.gen(function* () {
          const current = yield* gitConfigOnce(["--file", file, "--get-all", key], true, file);
          const settled = settledValue(
            (current ?? "")
              .split("\n")
              .map((candidate) => candidate.trim())
              .filter((candidate) => candidate.length > 0),
          );
          if (settled !== expected) {
            return yield* Effect.fail(
              new InvalidManagedIdentityError({
                message: `${key} changed before conditional replacement`,
              }),
            );
          }
          const original = yield* fs.stat(file);
          const temporary = yield* fs.makeTempFile({
            directory: dirname(file),
            prefix: ".supabase-git-config-",
          });
          return yield* Effect.acquireUseRelease(
            Effect.succeed(temporary),
            (path) =>
              Effect.gen(function* () {
                yield* fs.copyFile(file, path);
                yield* fs.chmod(path, original.mode);
                yield* gitConfigWrite(["--file", path, "--replace-all", key, value], path);
                yield* fs.rename(path, file);
              }),
            (path) => fs.remove(path, { force: true }).pipe(Effect.orDie),
          );
        }),
      () => fs.remove(lockPath, { force: true }).pipe(Effect.orDie),
    );
  }).pipe(Effect.catchTag("PlatformError", (error) => inaccessiblePlatformError(file, error)));

export const gitConfigStoreLayer: Layer.Layer<GitConfigStore> = Layer.succeed(GitConfigStore, {
  getAll: (file, key) =>
    Effect.map(gitConfig(["--file", file, "--get-all", key], true, file), (stdout) =>
      (stdout ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  getRegexp: (file, regexp) =>
    Effect.map(
      gitConfig(["--file", file, "--null", "--get-regexp", regexp], true, file),
      (stdout) =>
        (stdout ?? "").split("\0").flatMap((record) => {
          const separator = record.indexOf("\n");
          if (separator <= 0) return [];
          return [{ key: record.slice(0, separator), value: record.slice(separator + 1) }];
        }),
    ),
  add: (file, key, value) => gitConfigWrite(["--file", file, "--add", key, value], file),
  replace: (file, key, value) =>
    gitConfigWrite(["--file", file, "--replace-all", key, value], file),
  replaceExpected: (file, key, expected, value) =>
    gitConfigReplaceExpected(file, key, expected, value),
});

const requireUuid = (
  value: string,
  label: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Effect.try({
    try: () => assertManagedUuid(value, label),
    catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
  });

const mintUuid = (
  idFactory: () => string,
  label: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Effect.try({
    try: () => createManagedUuid(idFactory, label),
    catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
  });

/**
 * The value a config-stored identity has settled on.
 *
 * The first value wins, because that is the only choice that cannot change: git
 * appends, so a later claim lands after the first one and never displaces it.
 * Reading and claiming therefore agree even while a raced key is still
 * multi-valued.
 */
const settledValue = (values: ReadonlyArray<string>): string | undefined => values[0];

const readConfigId = (
  file: string,
  key: string,
  label: string,
): Effect.Effect<
  string | undefined,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  Effect.gen(function* () {
    const store = yield* GitConfigStore;
    const value = settledValue(yield* store.getAll(file, key));
    return value === undefined ? undefined : yield* requireUuid(value, label);
  });

/**
 * Claims a config-stored identity, adopting whichever value the repository
 * settled on.
 *
 * Git config has no compare-and-swap, so a claimant cannot publish
 * conditionally, and overwriting would lose a competing claim that a sibling
 * worktree has already reported. It appends instead — git's config lock
 * serializes appends and drops none of them — and then re-reads and adopts the
 * first value, which every claimant that appended sees. Two worktrees starting at
 * the same moment therefore agree on one project rather than splitting into two.
 *
 * A raced key is left holding more than one value, and whoever observes that
 * collapses it to the value everybody already agreed on. The collapse is
 * idempotent and preserves the first value, so it is safe to run against a
 * repository another claimant is still appending to, and a claimant that died
 * mid-race leaves nothing worse than a key the next one tidies up. It is
 * therefore hygiene rather than part of the claim, and a failed collapse does not
 * fail the claim it was tidying up after.
 */
const ensureConfigId = (
  file: string,
  key: string,
  label: string,
  idFactory: () => string,
): Effect.Effect<
  string,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  Effect.gen(function* () {
    const store = yield* GitConfigStore;
    const existing = yield* store.getAll(file, key);
    const values = yield* Effect.gen(function* () {
      if (existing.length > 0) {
        return existing;
      }
      yield* store.add(file, key, yield* mintUuid(idFactory, label));
      return yield* store.getAll(file, key);
    });

    const settled = settledValue(values);
    if (settled === undefined) {
      return yield* Effect.fail(
        new InvalidManagedIdentityError({ message: `${key} was claimed but is not set` }),
      );
    }
    const id = yield* requireUuid(settled, label);
    if (values.length > 1) {
      yield* Effect.catchDefect(
        Effect.catch(store.replace(file, key, id), () => Effect.void),
        () => Effect.void,
      );
    }
    return id;
  });

const readCheckoutIdentity = async (
  gitDirectory: string,
): Promise<GitCheckoutIdentity | undefined> => {
  try {
    return decodeGitCheckoutIdentity(await readFile(gitCheckoutIdentityPath(gitDirectory), "utf8"));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    if (
      error instanceof InvalidManagedIdentityError ||
      error instanceof UnsupportedGitWorkspaceError
    ) {
      throw error;
    }
    throw new UnsupportedGitWorkspaceError({
      path: gitCheckoutIdentityPath(gitDirectory),
      reason: `Git checkout identity is inaccessible (${errorCode(error) ?? String(error)})`,
      workspaceCause: "metadata-inaccessible",
    });
  }
};

/**
 * Claiming a checkout stays one `await` chain, for the reason
 * `ensureOrdinaryWorkspaceIdentity` does: reading the marker, publishing the
 * claim, and re-reading the marker a losing claimant must adopt are a single
 * indivisible protocol, and an interruption between those steps would leave the
 * caller with a checkout identity no git directory agreed to.
 *
 * The git directory always exists by the time this runs — inspection found it —
 * so the marker needs no directory created for it.
 */
interface CheckoutIdentityClaim {
  readonly checkoutId: string;
  /** Whether this call published the marker, rather than adopting a winner's. */
  readonly created: boolean;
}

const ensureCheckoutIdentity = async (
  gitDirectory: string,
  idFactory: () => string,
): Promise<CheckoutIdentityClaim> => {
  const existing = await readCheckoutIdentity(gitDirectory);
  if (existing !== undefined) {
    return { checkoutId: existing.checkoutId, created: false };
  }

  const identity: GitCheckoutIdentity = {
    version: GIT_CHECKOUT_IDENTITY_VERSION,
    checkoutId: createManagedUuid(idFactory, "checkoutId"),
  };
  let outcome: Awaited<ReturnType<typeof claimFileAtomically>>;
  try {
    outcome = await claimFileAtomically(
      gitCheckoutIdentityPath(gitDirectory),
      `${JSON.stringify(identity, null, 2)}\n`,
      {
        mode: 0o600,
        temporaryId: createManagedUuid(idFactory, "git checkout identity temporary id"),
      },
    );
  } catch (error: unknown) {
    if (
      error instanceof InvalidManagedIdentityError ||
      error instanceof UnsupportedGitWorkspaceError
    ) {
      throw error;
    }
    throw new UnsupportedGitWorkspaceError({
      path: gitCheckoutIdentityPath(gitDirectory),
      reason: `Git checkout identity is inaccessible (${errorCode(error) ?? String(error)})`,
      workspaceCause: "metadata-inaccessible",
    });
  }
  if (outcome === "claimed") {
    return { checkoutId: identity.checkoutId, created: true };
  }

  const winner = await readCheckoutIdentity(gitDirectory);
  if (winner === undefined) {
    throw new InvalidManagedIdentityError({
      message: "Checkout identity publication raced without a winning marker",
    });
  }
  return { checkoutId: winner.checkoutId, created: false };
};

export interface EnsureGitCheckoutIdentityResult {
  readonly projectId: string;
  readonly checkoutId: string;
  /** The common git directory, whose config holds the project identity. */
  readonly projectIdentityLocation: string;
  /** This checkout's git directory, which holds its checkout identity. */
  readonly checkoutIdentityLocation: string;
  /**
   * Whether this call published the checkout identity marker, as opposed to
   * adopting one a racing sibling had already claimed. Exactly one caller
   * racing on the same git directory sees `true`.
   */
  readonly checkoutIdentityCreated: boolean;
}

export interface GitCheckoutIdentityState {
  readonly projectId: string | undefined;
  readonly checkoutId: string | undefined;
  readonly projectIdentityLocation: string;
  readonly checkoutIdentityLocation: string;
}

/**
 * The project and checkout identities of a git checkout, minting whichever is
 * missing.
 *
 * The two are stored apart because git's own rules are what keep them correct.
 * The project identity is repository-local config, so every linked worktree —
 * including a bare repository's — reads the same one, and `git clone` copies none
 * of it, which is what makes a fresh clone a new project. The checkout identity
 * is a file in the checkout's own git directory, which is per-worktree by
 * construction.
 */
export const ensureGitCheckoutIdentity = (
  inspection: GitCheckoutInspection,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  EnsureGitCheckoutIdentityResult,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const projectId = yield* ensureConfigId(
        gitConfigPath(inspection.commonDirectory),
        GIT_PROJECT_ID_KEY,
        "projectId",
        idFactory,
      );
      const checkoutClaim = yield* Effect.tryPromise({
        try: () => ensureCheckoutIdentity(inspection.gitDirectory, idFactory),
        catch: asRaised,
      });
      return {
        projectId,
        checkoutId: checkoutClaim.checkoutId,
        projectIdentityLocation: inspection.commonDirectory,
        checkoutIdentityLocation: inspection.gitDirectory,
        checkoutIdentityCreated: checkoutClaim.created,
      };
    }),
  );

/** {@link ensureGitCheckoutIdentity} without the claim: absent stays absent. */
export const readGitCheckoutIdentity = (
  inspection: GitCheckoutInspection,
): Effect.Effect<
  GitCheckoutIdentityState,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const projectId = yield* readConfigId(
        gitConfigPath(inspection.commonDirectory),
        GIT_PROJECT_ID_KEY,
        "projectId",
      );
      const identity = yield* Effect.tryPromise({
        try: () => readCheckoutIdentity(inspection.gitDirectory),
        catch: asRaised,
      });
      return {
        projectId,
        checkoutId: identity?.checkoutId,
        projectIdentityLocation: inspection.commonDirectory,
        checkoutIdentityLocation: inspection.gitDirectory,
      };
    }),
  );

/** Read-only checkout marker probe through Effect FileSystem. */
export const readGitCheckoutIdentityWithFileSystem = (
  inspection: GitCheckoutInspection,
): Effect.Effect<
  GitCheckoutIdentityState,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore | FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectId = yield* readConfigId(
        gitConfigPath(inspection.commonDirectory),
        GIT_PROJECT_ID_KEY,
        "projectId",
      );
      const content = yield* fs
        .readFileString(gitCheckoutIdentityPath(inspection.gitDirectory))
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new UnsupportedGitWorkspaceError({
                    path: gitCheckoutIdentityPath(inspection.gitDirectory),
                    reason: `Git checkout identity is inaccessible (${error.message})`,
                    workspaceCause: "metadata-inaccessible",
                  }),
                ),
          ),
        );
      const identity =
        content === undefined
          ? undefined
          : yield* Effect.try({
              try: () => decodeGitCheckoutIdentity(content),
              catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
            });
      return {
        projectId,
        checkoutId: identity?.checkoutId,
        projectIdentityLocation: inspection.commonDirectory,
        checkoutIdentityLocation: inspection.gitDirectory,
      };
    }),
  );

const requireBranch = (branch: string): Effect.Effect<string, InvalidManagedIdentityError> =>
  branch.trim().length === 0
    ? Effect.fail(
        new InvalidManagedIdentityError({ message: "A branch context requires a branch name" }),
      )
    : Effect.succeed(branch);

/**
 * The context identity every checkout on `branch` shares, minting it if the
 * branch does not have one yet.
 *
 * It is stored in the shared repository config, so two worktrees on the same
 * branch resolve the same context while keeping their own checkout identities.
 */
export const ensureBranchContextId = (
  inspection: GitCheckoutInspection,
  branch: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  string,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  failsWithIdentity(
    Effect.flatMap(requireBranch(branch), (name) =>
      ensureConfigId(
        gitConfigPath(inspection.commonDirectory),
        gitBranchContextIdKey(name),
        "contextId",
        idFactory,
      ),
    ),
  );

/** {@link ensureBranchContextId} without the claim: absent stays absent. */
export const readBranchContextId = (
  inspection: GitCheckoutInspection,
  branch: string,
): Effect.Effect<
  string | undefined,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore
> =>
  failsWithIdentity(
    Effect.flatMap(requireBranch(branch), (name) =>
      readConfigId(
        gitConfigPath(inspection.commonDirectory),
        gitBranchContextIdKey(name),
        "contextId",
      ),
    ),
  );

/**
 * Replaces the context claim for one branch after its identity transition has
 * been reserved.  The transition owns the expected value and callers reread
 * the key immediately after this write; this helper deliberately does not
 * mint or otherwise merge values.
 */
export const replaceBranchContextId = (
  inspection: GitCheckoutInspection,
  branch: string,
  expectedContextId: string,
  contextId: string,
): Effect.Effect<
  void,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  GitConfigStore | FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const name = yield* requireBranch(branch);
      const id = yield* requireUuid(contextId, "contextId");
      const expected = yield* requireUuid(expectedContextId, "expected contextId");
      const store = yield* GitConfigStore;
      yield* store.replaceExpected(
        gitConfigPath(inspection.commonDirectory),
        gitBranchContextIdKey(name),
        expected,
        id,
      );
    }),
  );
