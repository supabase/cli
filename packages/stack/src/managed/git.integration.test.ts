import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vitest";
import { Cause, Effect, Exit, FileSystem, Layer, PlatformError } from "effect";
import {
  git,
  makeBareRepository,
  makeDirectory,
  makeRepository,
  storedConfigValue,
  temporaryRoots,
} from "../../tests/helpers/git-workspace.ts";
import {
  ensureBranchContextId,
  ensureGitCheckoutIdentity,
  gitBranchContextIdKey,
  gitConfigStoreLayer,
  GIT_PROJECT_ID_KEY,
  inspectWorkspace,
  readBranchContextId,
  readGitCheckoutIdentity,
  replaceBranchContextId,
  type GitCheckoutInspection,
} from "./git.ts";
import { publishGitCheckoutIdentity } from "./identity.ts";
import { InvalidManagedIdentityError, UnsupportedGitWorkspaceError } from "./model.ts";
import { gitCheckoutIdentityPath, gitConfigPath, gitWorktreeConfigPath } from "./paths.ts";

/**
 * Git topology and git-stored identity, exercised against repositories the real
 * git binary builds: the whole point of storing identity where git stores it is
 * that git's own lifecycle rules — worktree layout, config inheritance, branch
 * renames, what a clone copies — do the work, and none of those rules can be
 * observed against a stub.
 */

const { makeRoot, removeAll } = temporaryRoots("managed-git-test-");

const reftableInitSupported = (() => {
  const root = mkdtempSync(join(tmpdir(), "managed-git-reftable-capability-"));
  try {
    git(root, "init", "-q", "--ref-format=reftable");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
})();

const reftableTest = it.live.skipIf(!reftableInitSupported);

afterEach(removeAll);

const gitLayer = Layer.mergeAll(BunFileSystem.layer, gitConfigStoreLayer);

/**
 * The inspection of a path the test built as a checkout. A different
 * classification is a broken fixture rather than a scenario, so it is a defect.
 */
const inspectCheckout = (
  path: string,
): Effect.Effect<GitCheckoutInspection, UnsupportedGitWorkspaceError, FileSystem.FileSystem> =>
  Effect.flatMap(inspectWorkspace(path), (inspection) =>
    inspection.kind === "git-checkout"
      ? Effect.succeed(inspection)
      : Effect.die(new Error(`${path} was classified as ${inspection.kind}`)),
  );

/**
 * Config git accepts but never writes itself, put where a repository keeps its
 * own. The inspection path reads config with a line scan, so it has to agree
 * with git about which line answers a key — not only about the shape git emits.
 */
const prependToConfig = (file: string, content: string): void =>
  writeFileSync(file, `${content}${readFileSync(file, "utf8")}`);

const appendToConfig = (file: string, content: string): void =>
  writeFileSync(file, `${readFileSync(file, "utf8")}${content}`);

const expectNothingClaimed = (inspection: GitCheckoutInspection, branch: string): void => {
  expect(existsSync(gitCheckoutIdentityPath(inspection.gitDirectory))).toBe(false);
  const config = gitConfigPath(inspection.commonDirectory);
  expect(storedConfigValue(config, GIT_PROJECT_ID_KEY)).toBeUndefined();
  expect(storedConfigValue(config, gitBranchContextIdKey(branch))).toBeUndefined();
};

describe("workspace topology", () => {
  it.live("classifies a folder outside any repository as an ordinary folder", () =>
    Effect.gen(function* () {
      const workspace = makeDirectory(makeRoot(), "workspace");

      const inspection = yield* inspectWorkspace(workspace);

      expect(inspection).toEqual({ kind: "ordinary-folder", canonicalPath: workspace });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("turns an inaccessible metadata filesystem failure into a typed refusal", () =>
    Effect.gen(function* () {
      const workspace = makeRepository(makeRoot());
      const sharedConfig = gitConfigPath(join(workspace, ".git"));
      const failingFileSystem = Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        readFileString: (path: string, encoding?: string) =>
          path === sharedConfig
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "test",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : fs.readFileString(path, encoding),
      }));

      const failure = yield* Effect.flip(
        inspectWorkspace(workspace).pipe(
          Effect.provideServiceEffect(FileSystem.FileSystem, failingFileSystem),
        ),
      );

      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      if (failure instanceof UnsupportedGitWorkspaceError) {
        expect(failure.workspaceCause).toBe("metadata-inaccessible");
      }
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("resolves a primary checkout the same way from its root and from a nested path", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const nested = makeDirectory(repository, join("src", "deep"));

      const fromRoot = yield* inspectCheckout(repository);
      expect(fromRoot.checkoutKind).toBe("primary");
      expect(fromRoot.workspaceRoot).toBe(repository);
      expect(fromRoot.gitDirectory).toBe(join(repository, ".git"));
      expect(fromRoot.commonDirectory).toBe(fromRoot.gitDirectory);
      expect(fromRoot.head).toEqual({ kind: "branch", branch: "main" });

      const fromNested = yield* inspectCheckout(nested);
      expect(fromNested.canonicalPath).toBe(nested);
      expect(fromNested.workspaceRoot).toBe(repository);
      expect(fromNested.gitDirectory).toBe(fromRoot.gitDirectory);
      expect(fromNested.head).toEqual(fromRoot.head);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("rejects a checkout whose .git target is dangling metadata", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const workspace = makeDirectory(root, "workspace");
      const dangling = join(root, "missing-git-directory");
      writeFileSync(join(workspace, ".git"), `gitdir: ${dangling}\n`);

      const failure = yield* Effect.flip(inspectWorkspace(workspace));

      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(failure.workspaceCause).toBe("malformed-metadata");
      expect(failure.cause).toBeUndefined();
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("rejects a linked worktree whose commondir metadata is dangling", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const worktree = join(root, "wt-a");
      git(repository, "worktree", "add", "-q", worktree, "-b", "feat/a");
      const gitDirectory = join(repository, ".git", "worktrees", "wt-a");
      writeFileSync(join(gitDirectory, "commondir"), "../../missing-common-directory\n");

      const failure = yield* Effect.flip(inspectWorkspace(worktree));

      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(failure.workspaceCause).toBe("malformed-metadata");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("rejects an empty linked-worktree commondir instead of treating it as primary", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const worktree = join(root, "wt-a");
      git(repository, "worktree", "add", "-q", worktree, "-b", "feat/a");
      const gitDirectory = join(repository, ".git", "worktrees", "wt-a");
      writeFileSync(join(gitDirectory, "commondir"), "  \n\t");

      const failure = yield* Effect.flip(inspectWorkspace(worktree));

      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(failure.workspaceCause).toBe("malformed-metadata");
      expect(existsSync(gitCheckoutIdentityPath(gitDirectory))).toBe(false);
      expect(storedConfigValue(gitConfigPath(join(repository, ".git")), GIT_PROJECT_ID_KEY)).toBe(
        undefined,
      );
      expect(storedConfigValue(gitConfigPath(gitDirectory), GIT_PROJECT_ID_KEY)).toBe(undefined);
      expect(
        storedConfigValue(gitConfigPath(join(repository, ".git")), gitBranchContextIdKey("feat/a")),
      ).toBe(undefined);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("rejects unsafe separators and path segments in a symbolic HEAD ref", () =>
    Effect.gen(function* () {
      for (const ref of [
        "refs/heads/../../../../etc/shadow",
        "refs/heads/feature//name",
        "refs/heads/..\\..\\target",
      ]) {
        const repository = makeRepository(makeRoot());
        writeFileSync(join(repository, ".git", "HEAD"), `ref: ${ref}\n`);

        const failure = yield* Effect.flip(inspectWorkspace(repository));

        expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
        expect(failure.workspaceCause).toBe("malformed-metadata");
      }
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reports a detached HEAD with the commit it is parked on", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const commit = git(repository, "rev-parse", "HEAD").trim();
      git(repository, "checkout", "-q", commit);

      const inspection = yield* inspectCheckout(repository);

      expect(inspection.head).toEqual({ kind: "detached", commit });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("accepts an uppercase object id in a detached HEAD", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const commit = git(repository, "rev-parse", "HEAD").trim().toUpperCase();
      writeFileSync(join(repository, ".git", "HEAD"), `${commit}\n`);

      const inspection = yield* inspectCheckout(repository);

      expect(inspection.head).toEqual({ kind: "detached", commit });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reports the initial branch of a repository that has no commits yet", () =>
    Effect.gen(function* () {
      const fresh = makeDirectory(makeRoot(), "fresh");
      git(fresh, "init", "-q", "-b", "main");

      const inspection = yield* inspectCheckout(fresh);
      expect(inspection.checkoutKind).toBe("primary");
      expect(inspection.head).toEqual({ kind: "unborn", branch: "main" });

      // An unborn branch still names a context, so a first start can create one.
      const contextId = yield* ensureBranchContextId(inspection, "main");
      expect(yield* readBranchContextId(inspection, "main")).toBe(contextId);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("keeps classifying a bare repository's worktree once git moves core.bare", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const bare = makeBareRepository(root, makeRepository(root));
      git(bare, "worktree", "add", "-q", join(root, "bare-a"), "-b", "bare-a", "main");
      // `git sparse-checkout` turns `extensions.worktreeConfig` on by itself, and
      // git then moves `core.bare` out of the shared config into the worktree
      // config beside it — where a reader of the shared config alone stops seeing
      // it, and reports a worktree of a bare repository as an ordinary one.
      git(join(root, "bare-a"), "sparse-checkout", "set", ".");
      expect(storedConfigValue(gitConfigPath(bare), "core.bare")).toBeUndefined();
      expect(storedConfigValue(gitWorktreeConfigPath(bare), "core.bare")).toBe("true");

      const worktree = yield* inspectCheckout(join(root, "bare-a"));

      expect(worktree.checkoutKind).toBe("bare-worktree");
      expect(worktree.commonDirectory).toBe(bare);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("honors a quoted extensions.worktreeConfig and a quoted core.bare it routes to", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const bare = makeBareRepository(root, makeRepository(root));
      git(bare, "worktree", "add", "-q", join(root, "bare-a"), "-b", "bare-a", "main");
      git(join(root, "bare-a"), "sparse-checkout", "set", ".");

      // git wrote both flags as bare words; quote them the way a hand-edited
      // config might, and confirm the scan still agrees with `git config --get`.
      const sharedConfig = gitConfigPath(bare);
      writeFileSync(
        sharedConfig,
        readFileSync(sharedConfig, "utf8").replace(/(worktreeConfig\s*=\s*)true/i, '$1"true"'),
      );
      const worktreeConfig = gitWorktreeConfigPath(bare);
      writeFileSync(
        worktreeConfig,
        readFileSync(worktreeConfig, "utf8").replace(/(bare\s*=\s*)true/i, '$1"true"'),
      );
      expect(storedConfigValue(sharedConfig, "extensions.worktreeConfig")).toBe("true");
      expect(storedConfigValue(worktreeConfig, "core.bare")).toBe("true");

      const worktree = yield* inspectCheckout(join(root, "bare-a"));

      expect(worktree.checkoutKind).toBe("bare-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("leaves core.bare to the plain section when a subsection shares its name", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      const config = gitConfigPath(join(repository, ".git"));
      // `[core "fake"]` is a section of its own, and the `bare` under it is not
      // `core.bare` — git keeps answering with the plain `[core]` below it.
      prependToConfig(config, '[core "fake"]\n\tbare = true\n');
      expect(storedConfigValue(config, "core.bare")).toBe("false");

      const worktree = yield* inspectCheckout(join(root, "wt-a"));

      expect(worktree.checkoutKind).toBe("linked-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("settles on the last core.bare a repository sets", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      const config = gitConfigPath(join(repository, ".git"));
      // A later `[core]` overrides the `bare = false` git wrote at init, so the
      // repository is bare and its linked checkouts are worktrees of a bare one.
      appendToConfig(config, "[core]\n\tbare = true\n");
      expect(storedConfigValue(config, "core.bare")).toBe("true");

      const worktree = yield* inspectCheckout(join(root, "wt-a"));

      expect(worktree.checkoutKind).toBe("bare-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("classifies a bare repository's worktree when core.bare is quoted", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      const config = gitConfigPath(join(repository, ".git"));
      // A hand-edited config may quote a value git itself always writes bare;
      // git's own reader still honors the quotes, and so must this scan.
      appendToConfig(config, '[core]\n\tbare = "true"\n');
      expect(storedConfigValue(config, "core.bare")).toBe("true");

      const worktree = yield* inspectCheckout(join(root, "wt-a"));

      expect(worktree.checkoutKind).toBe("bare-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("distinguishes valueless core.bare from an explicitly empty value", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      const config = gitConfigPath(join(repository, ".git"));

      appendToConfig(config, "[core]\n\tbare = ; explicitly empty\n");
      expect((yield* inspectCheckout(join(root, "wt-a"))).checkoutKind).toBe("linked-worktree");

      appendToConfig(config, '[core]\n\tbare = ""\n');
      expect((yield* inspectCheckout(join(root, "wt-a"))).checkoutKind).toBe("linked-worktree");

      appendToConfig(config, "[core]\n\tbare\n");
      expect((yield* inspectCheckout(join(root, "wt-a"))).checkoutKind).toBe("bare-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("applies the same boolean distinction in worktree config", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const source = makeRepository(root);
      const bare = makeBareRepository(root, source);
      const worktree = join(root, "bare-a");
      git(bare, "worktree", "add", "-q", worktree, "-b", "bare-a", "main");
      git(worktree, "sparse-checkout", "set", ".");
      const config = gitWorktreeConfigPath(bare);

      appendToConfig(config, "[core]\n\tbare = # explicitly empty\n");
      expect((yield* inspectCheckout(worktree)).checkoutKind).toBe("linked-worktree");

      appendToConfig(config, "[core]\n\tbare\n");
      expect((yield* inspectCheckout(worktree)).checkoutKind).toBe("bare-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reads extensions.refStorage from the plain section only", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const config = gitConfigPath(join(repository, ".git"));
      appendToConfig(config, '[extensions "fake"]\n\trefStorage = reftable\n');

      const unaffected = yield* inspectCheckout(repository);
      expect(unaffected.checkoutKind).toBe("primary");

      appendToConfig(config, "[extensions]\n\trefStorage = reftable\n");
      expect(storedConfigValue(config, "extensions.refStorage")).toBe("reftable");

      const refused = yield* Effect.flip(inspectWorkspace(repository));
      expect(refused).toBeInstanceOf(UnsupportedGitWorkspaceError);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("still refuses a repository whose quoted extensions.refStorage names a reftable", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const config = gitConfigPath(join(repository, ".git"));
      // A hand-edited config may quote this value too; the refusal must not
      // depend on it staying a bare word.
      appendToConfig(config, '[extensions]\n\trefStorage = "reftable"\n');
      expect(storedConfigValue(config, "extensions.refStorage")).toBe("reftable");

      const refused = yield* Effect.flip(inspectWorkspace(repository));
      expect(refused).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(refused.workspaceCause).toBe("reftable");
    }).pipe(Effect.provide(gitLayer)),
  );

  reftableTest("refuses a repository whose refs are stored in a reftable", () =>
    Effect.gen(function* () {
      // A reftable repository keeps its refs in `reftable/` and leaves a compat
      // stub at `HEAD` naming `refs/heads/.invalid`, so reading it as a ref-file
      // repository would report every branch and every detached `HEAD` in it as
      // one unborn branch called `.invalid` — one bogus shared context.
      const reftable = makeDirectory(makeRoot(), "reftable");
      git(reftable, "init", "-q", "--ref-format=reftable", "-b", "main");
      git(reftable, "commit", "-q", "--allow-empty", "-m", "init");
      git(reftable, "checkout", "-q", "-b", "feat/x");
      const gitDirectory = join(reftable, ".git");

      const refused = yield* Effect.flip(inspectWorkspace(reftable));
      expect(refused).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(refused.code).toBe("UNSUPPORTED_GIT_WORKSPACE");
      expect(refused.workspaceCause).toBe("reftable");

      // The `HEAD` stub is the tripwire behind the extension: a repository whose
      // `extensions.refStorage` cannot be read is still refused rather than
      // resolved to a `.invalid` context.
      writeFileSync(
        gitConfigPath(gitDirectory),
        readFileSync(gitConfigPath(gitDirectory), "utf8")
          .split("\n")
          .filter((line) => !/refstorage/i.test(line))
          .join("\n"),
      );
      const stillRefused = yield* Effect.flip(inspectWorkspace(reftable));
      expect(stillRefused).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(stillRefused.workspaceCause).toBe("reftable");

      // A workspace nothing could classify is a workspace nothing claimed.
      expect(existsSync(gitCheckoutIdentityPath(gitDirectory))).toBe(false);
      expect(storedConfigValue(gitConfigPath(gitDirectory), GIT_PROJECT_ID_KEY)).toBeUndefined();
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("refuses a git directory and a bare repository as workspaces", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      makeBareRepository(root, repository);

      for (const path of [
        join(repository, ".git"),
        join(repository, ".git", "refs"),
        join(root, "bare.git"),
      ]) {
        const failure = yield* Effect.flip(inspectWorkspace(path));
        expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
        expect(failure.code).toBe("UNSUPPORTED_GIT_WORKSPACE");
        expect(failure.workspaceCause).toBe("inside-git-directory");
      }
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("git-stored identity", () => {
  it.live("refuses a raced checkout marker with an unsupported version", () =>
    Effect.gen(function* () {
      const gitDirectory = makeDirectory(makeRoot(), "git-directory");
      const markerPath = gitCheckoutIdentityPath(gitDirectory);
      const checkoutId = "00000000-0000-7000-8000-000000000304";
      const baseFileSystem = yield* FileSystem.FileSystem;
      let firstRead = true;
      const racingFileSystem = {
        ...baseFileSystem,
        readFileString: (path: string, encoding?: string) => {
          if (path !== markerPath || !firstRead)
            return baseFileSystem.readFileString(path, encoding);
          firstRead = false;
          return Effect.sync(() => {
            writeFileSync(markerPath, JSON.stringify({ version: 2, checkoutId }));
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "test",
                  method: "readFileString",
                  pathOrDescriptor: markerPath,
                }),
              ),
            ),
          );
        },
      };

      const exit = yield* Effect.exit(
        publishGitCheckoutIdentity(gitDirectory, checkoutId).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidManagedIdentityError);
      }
      expect(readFileSync(markerPath, "utf8")).toContain('"version":2');
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("holds the Git config lock across validation and publication", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const inspection = yield* inspectCheckout(repository);
      const expected = "00000000-0000-7000-8000-000000000301";
      const target = "00000000-0000-7000-8000-000000000303";
      git(repository, "config", gitBranchContextIdKey("main"), expected);
      const config = gitConfigPath(inspection.commonDirectory);
      const baseFileSystem = yield* FileSystem.FileSystem;
      let writerBlocked = false;
      const racingFileSystem = {
        ...baseFileSystem,
        writeFileString: (
          path: string,
          data: string,
          options?: { readonly flag?: FileSystem.OpenFlag; readonly mode?: number },
        ) =>
          Effect.tap(baseFileSystem.writeFileString(path, data, options), () =>
            Effect.sync(() => {
              if (path !== `${config}.lock`) return;
              try {
                git(repository, "config", "--replace-all", gitBranchContextIdKey("main"), target);
              } catch {
                writerBlocked = true;
              }
            }),
          ),
      };

      yield* replaceBranchContextId(inspection, "main", expected, target).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFileSystem),
      );
      expect(writerBlocked).toBe(true);
      expect(storedConfigValue(config, gitBranchContextIdKey("main"))).toBe(target);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("collapses duplicated equal branch context values during replacement", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const inspection = yield* inspectCheckout(repository);
      const expected = "00000000-0000-7000-8000-000000000304";
      const target = "00000000-0000-7000-8000-000000000305";
      const config = gitConfigPath(inspection.commonDirectory);
      git(repository, "config", gitBranchContextIdKey("main"), expected);
      git(repository, "config", "--add", gitBranchContextIdKey("main"), expected);

      yield* replaceBranchContextId(inspection, "main", expected, target);

      expect(storedConfigValue(config, gitBranchContextIdKey("main"))).toBe(target);
      expect(git(repository, "config", "--get-all", gitBranchContextIdKey("main"))).toBe(
        `${target}\n`,
      );
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("gives sibling linked worktrees one project and separate checkouts", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      git(repository, "worktree", "add", "-q", join(root, "wt-b"), "-b", "feat/b");

      const worktreeA = yield* inspectCheckout(join(root, "wt-a"));
      const worktreeB = yield* inspectCheckout(join(root, "wt-b"));
      expect(worktreeA.checkoutKind).toBe("linked-worktree");
      expect(worktreeA.workspaceRoot).toBe(join(root, "wt-a"));
      expect(worktreeA.gitDirectory).toBe(join(repository, ".git", "worktrees", "wt-a"));
      expect(worktreeA.commonDirectory).toBe(join(repository, ".git"));
      expect(worktreeA.head).toEqual({ kind: "branch", branch: "feat/a" });
      expect(worktreeB.gitDirectory).toBe(join(repository, ".git", "worktrees", "wt-b"));

      const identityA = yield* ensureGitCheckoutIdentity(worktreeA);
      const identityB = yield* ensureGitCheckoutIdentity(worktreeB);

      expect(identityB.projectId).toBe(identityA.projectId);
      expect(identityB.checkoutId).not.toBe(identityA.checkoutId);
      expect(identityA.projectIdentityLocation).toBe(join(repository, ".git"));
      expect(identityA.checkoutIdentityLocation).toBe(worktreeA.gitDirectory);
      expect(identityB.checkoutIdentityLocation).toBe(worktreeB.gitDirectory);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("shares a bare repository's project across worktrees without a primary one", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const bare = makeBareRepository(root, repository);
      git(bare, "worktree", "add", "-q", join(root, "bare-a"), "-b", "bare-a", "main");
      git(bare, "worktree", "add", "-q", join(root, "bare-b"), "-b", "bare-b", "main");

      const worktreeA = yield* inspectCheckout(join(root, "bare-a"));
      const worktreeB = yield* inspectCheckout(join(root, "bare-b"));
      expect(worktreeA.checkoutKind).toBe("bare-worktree");
      expect(worktreeB.checkoutKind).toBe("bare-worktree");
      expect(worktreeA.commonDirectory).toBe(bare);
      expect(worktreeA.gitDirectory).toBe(join(bare, "worktrees", "bare-a"));
      expect(worktreeB.gitDirectory).toBe(join(bare, "worktrees", "bare-b"));

      const identityA = yield* ensureGitCheckoutIdentity(worktreeA);
      const identityB = yield* ensureGitCheckoutIdentity(worktreeB);

      expect(identityB.projectId).toBe(identityA.projectId);
      expect(identityB.checkoutId).not.toBe(identityA.checkoutId);
      expect(identityA.projectIdentityLocation).toBe(bare);
      expect(storedConfigValue(gitConfigPath(bare), GIT_PROJECT_ID_KEY)).toBe(identityA.projectId);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("shares one context between two worktrees of the same branch", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-f", "--checkout", join(root, "wt-main"), "main");

      const primary = yield* inspectCheckout(repository);
      const forced = yield* inspectCheckout(join(root, "wt-main"));
      expect(forced.head).toEqual({ kind: "branch", branch: "main" });

      const contextPrimary = yield* ensureBranchContextId(primary, "main");
      const contextForced = yield* ensureBranchContextId(forced, "main");
      expect(contextForced).toBe(contextPrimary);

      // The shared context does not merge the checkouts themselves.
      const identityPrimary = yield* ensureGitCheckoutIdentity(primary);
      const identityForced = yield* ensureGitCheckoutIdentity(forced);
      expect(identityForced.projectId).toBe(identityPrimary.projectId);
      expect(identityForced.checkoutId).not.toBe(identityPrimary.checkoutId);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("keys a context by the exact branch name, slashes included", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      git(repository, "checkout", "-q", "-b", "feature/x");

      const inspection = yield* inspectCheckout(repository);
      expect(inspection.head).toEqual({ kind: "branch", branch: "feature/x" });

      const contextId = yield* ensureBranchContextId(inspection, "feature/x");
      expect(yield* readBranchContextId(inspection, "feature/x")).toBe(contextId);
      expect(yield* readBranchContextId(inspection, "feature")).toBeUndefined();
      expect(
        storedConfigValue(
          gitConfigPath(inspection.commonDirectory),
          gitBranchContextIdKey("feature/x"),
        ),
      ).toBe(contextId);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("follows a renamed branch to its new name", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      git(repository, "checkout", "-q", "-b", "feature/x");
      const inspection = yield* inspectCheckout(repository);
      const contextId = yield* ensureBranchContextId(inspection, "feature/x");

      git(repository, "branch", "-m", "feature/x", "feature/renamed");

      const renamed = yield* inspectCheckout(repository);
      expect(renamed.head).toEqual({ kind: "branch", branch: "feature/renamed" });
      expect(yield* readBranchContextId(renamed, "feature/renamed")).toBe(contextId);
      expect(yield* readBranchContextId(renamed, "feature/x")).toBeUndefined();
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("leaves a fresh clone without the project it was cloned from", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const source = yield* inspectCheckout(repository);
      const sourceIdentity = yield* ensureGitCheckoutIdentity(source);
      yield* ensureBranchContextId(source, "main");

      git(root, "clone", "-q", repository, "clone");
      const clone = yield* inspectCheckout(join(root, "clone"));

      const cloned = yield* readGitCheckoutIdentity(clone);
      expect(cloned.projectId).toBeUndefined();
      expect(cloned.checkoutId).toBeUndefined();
      expect(yield* readBranchContextId(clone, "main")).toBeUndefined();

      const cloneIdentity = yield* ensureGitCheckoutIdentity(clone);
      expect(cloneIdentity.projectId).not.toBe(sourceIdentity.projectId);
      expect(cloneIdentity.checkoutId).not.toBe(sourceIdentity.checkoutId);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("claims nothing while inspecting and reading", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      makeBareRepository(root, repository);
      git(join(root, "bare.git"), "worktree", "add", "-q", join(root, "bare-a"), "-b", "bare-a");

      for (const path of [repository, join(root, "wt-a"), join(root, "bare-a")]) {
        const inspection = yield* inspectCheckout(path);
        const state = yield* readGitCheckoutIdentity(inspection);
        expect(state.projectId).toBeUndefined();
        expect(state.checkoutId).toBeUndefined();
        expect(yield* readBranchContextId(inspection, "main")).toBeUndefined();
        expectNothingClaimed(inspection, "main");
      }
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reports malformed shared git config as a typed workspace failure", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const inspection = yield* inspectCheckout(repository);
      appendToConfig(gitConfigPath(inspection.commonDirectory), "[core\n");

      const failure = yield* Effect.flip(readGitCheckoutIdentity(inspection));
      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      if (failure instanceof UnsupportedGitWorkspaceError) {
        expect(failure.workspaceCause).toBe("malformed-metadata");
        expect(failure.cause).toBeUndefined();
      }
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("converges on one project when sibling worktrees claim at the same moment", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
      git(repository, "worktree", "add", "-q", join(root, "wt-b"), "-b", "feat/b");
      const checkouts = yield* Effect.all(
        [repository, join(root, "wt-a"), join(root, "wt-b")].map(inspectCheckout),
      );

      const claims = yield* Effect.all(
        checkouts.flatMap((checkout) =>
          Array.from({ length: 4 }, () => ensureGitCheckoutIdentity(checkout)),
        ),
        { concurrency: "unbounded" },
      );

      const stored = yield* Effect.all(checkouts.map(readGitCheckoutIdentity));
      expect(new Set(claims.map((claim) => claim.projectId)).size).toBe(1);
      expect(new Set(stored.map((state) => state.projectId))).toEqual(
        new Set([claims[0]?.projectId]),
      );
      // Every checkout still settled on exactly one identity of its own.
      expect(new Set(claims.map((claim) => claim.checkoutId))).toEqual(
        new Set(stored.map((state) => state.checkoutId)),
      );
      expect(new Set(stored.map((state) => state.checkoutId)).size).toBe(checkouts.length);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reports exactly one claimant as having published a racing checkout's identity", () =>
    Effect.gen(function* () {
      const checkout = yield* inspectCheckout(makeRepository(makeRoot()));

      const claims = yield* Effect.all(
        Array.from({ length: 8 }, () => ensureGitCheckoutIdentity(checkout)),
        { concurrency: "unbounded" },
      );

      // Every racing claimant settles on the same checkout identity, but only
      // the one that actually published the marker may report having created
      // it — the others adopted the winner's marker instead.
      expect(new Set(claims.map((claim) => claim.checkoutId)).size).toBe(1);
      expect(claims.filter((claim) => claim.checkoutIdentityCreated).length).toBe(1);
    }).pipe(Effect.provide(gitLayer)),
  );
});
