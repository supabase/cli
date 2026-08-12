import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vitest";
import { Effect, Layer, type FileSystem } from "effect";
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
  type GitCheckoutInspection,
} from "./git.ts";
import { UnsupportedGitWorkspaceError } from "./model.ts";
import { gitCheckoutIdentityPath, gitConfigPath, gitWorktreeConfigPath } from "./paths.ts";

/**
 * Git topology and git-stored identity, exercised against repositories the real
 * git binary builds: the whole point of storing identity where git stores it is
 * that git's own lifecycle rules — worktree layout, config inheritance, branch
 * renames, what a clone copies — do the work, and none of those rules can be
 * observed against a stub.
 */

const { makeRoot, removeAll } = temporaryRoots("managed-git-test-");

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

  it.live("reports a detached HEAD with the commit it is parked on", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const commit = git(repository, "rev-parse", "HEAD").trim();
      git(repository, "checkout", "-q", commit);

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

  it.live("refuses a repository whose refs are stored in a reftable", () =>
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
      }
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("git-stored identity", () => {
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
