// oxlint-disable effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Integration tests and subprocess fixtures intentionally inspect generic Effect failures at the boundary.
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect } from "vitest";
import { cpSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  git,
  makeBareRepository,
  makeRepository,
  storedConfigValue,
  temporaryRoots,
} from "../tests/helpers/git-workspace.ts";
import {
  discoverEnvironment,
  deriveStackId,
  ensureEnvironment,
  validateEnvironmentRepair,
} from "./managed/environment.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";

const { makeRoot, removeAll } = temporaryRoots("managed-environment-test-");
const gitLayer = Layer.mergeAll(NodeFileSystem.layer, gitConfigStoreLayer);

interface GitWorkspace {
  readonly root: string;
  readonly primary: string;
  readonly checkoutNewBranch: (branch: string) => void;
  readonly checkout: (branch: string) => void;
  readonly addWorktree: (
    name: string,
    branch: string,
    options?: { readonly force?: boolean },
  ) => string;
}

const withGitWorkspace = <A>(run: (workspace: GitWorkspace) => Effect.Effect<A, any, any>) => {
  const root = makeRoot();
  const primary = makeRepository(root);
  const workspace: GitWorkspace = {
    root,
    primary,
    checkoutNewBranch: (branch) => git(primary, "checkout", "-q", "-b", branch),
    checkout: (branch) => git(primary, "checkout", "-q", branch),
    addWorktree: (name, branch, options = {}) => {
      const path = `${root}/${name}`;
      const args = ["worktree", "add", "-q"];
      if (options.force === true) args.push("-f", "--checkout");
      args.push(path, branch);
      git(primary, ...args);
      return path;
    },
  };
  return Effect.ensuring(run(workspace), Effect.sync(removeAll));
};

afterEach(removeAll);

describe("managed environment identity", () => {
  it.live("returns to the same stack after leaving and revisiting a branch", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const main = yield* ensureEnvironment(workspace.primary);
        workspace.checkoutNewBranch("feature");
        const feature = yield* ensureEnvironment(workspace.primary);
        workspace.checkout("main");
        const mainAgain = yield* discoverEnvironment(workspace.primary);
        expect(deriveStackId(main.identity, "default")).toBe(
          deriveStackId(mainAgain.identity, "default"),
        );
        expect(feature.identity.contextId).not.toBe(main.identity.contextId);
      }),
    ).pipe(Effect.provide(gitLayer)),
  );

  it.live("isolates the same branch in two worktrees by checkout identity", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const sibling = workspace.addWorktree("sibling", "main", { force: true });
        const first = yield* ensureEnvironment(workspace.primary);
        const second = yield* ensureEnvironment(sibling);
        expect(first.identity.contextId).toBe(second.identity.contextId);
        expect(first.identity.checkoutId).not.toBe(second.identity.checkoutId);
        expect(deriveStackId(first.identity, "default")).not.toBe(
          deriveStackId(second.identity, "default"),
        );
      }),
    ).pipe(Effect.provide(gitLayer)),
  );

  it.live("keeps bare-clone worktree identity stable across repeated discovery", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const bare = makeBareRepository(workspace.root, workspace.primary);
        const firstPath = join(workspace.root, "bare-first");
        const secondPath = join(workspace.root, "bare-second");
        git(bare, "worktree", "add", "-q", firstPath, "-b", "feature/first", "main");
        git(bare, "worktree", "add", "-q", secondPath, "-b", "feature/second", "main");

        // Git enables worktree-scoped config itself and relocates core.bare when
        // sparse-checkout is initialized; the fixture must exercise that path.
        git(firstPath, "sparse-checkout", "set", ".");
        expect(git(bare, "config", "--get", "extensions.worktreeConfig").trim()).toBe("true");
        expect(storedConfigValue(join(bare, "config"), "core.bare")).toBeUndefined();
        expect(storedConfigValue(join(bare, "config.worktree"), "core.bare")).toBe("true");

        const first = yield* ensureEnvironment(firstPath);
        const second = yield* ensureEnvironment(secondPath);
        const firstAgain = yield* discoverEnvironment(firstPath);

        expect(first.workspace.checkoutKind).toBe("bare");
        expect(second.workspace.checkoutKind).toBe("bare");
        expect(first.identity.workspaceId).toBe(second.identity.workspaceId);
        expect(first.identity.checkoutId).not.toBe(second.identity.checkoutId);
        expect(first.identity.contextId).not.toBe(second.identity.contextId);
        expect(firstAgain).toEqual(first);
      }),
    ).pipe(Effect.provide(gitLayer)),
  );

  it.live("requires explicit repair when a checkout identity appears at a new path", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const original = workspace.primary;
        const registered = yield* ensureEnvironment(original);
        const movedPath = `${workspace.root}/moved`;
        renameSync(original, movedPath);
        const report = yield* discoverEnvironment(movedPath);
        expect(report.state).toBe("needsRepair");
        if (report.state !== "needsRepair") throw new Error("expected moved checkout");
        expect(report.reason).toBe("moved");
        const repair = yield* validateEnvironmentRepair(report.repair);
        expect(repair).toEqual(report.repair);
        const after = yield* discoverEnvironment(movedPath);
        expect(after.state).toBe("needsRepair");
        expect(after.identity).toEqual(registered.identity);
      }),
    ).pipe(Effect.provide(gitLayer)),
  );

  it.live("rejects a forged nested update in a moved repair plan", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const original = workspace.primary;
        yield* ensureEnvironment(original);
        const movedPath = `${workspace.root}/moved-forged`;
        renameSync(original, movedPath);
        const report = yield* discoverEnvironment(movedPath);
        if (report.state !== "needsRepair") throw new Error("expected moved checkout");
        const update = report.repair.updates[0];
        if (update === undefined) throw new Error("expected one moved repair update");
        const forged = {
          ...report.repair,
          updates: [{ ...update, to: update.from }],
        };
        const result = yield* validateEnvironmentRepair(forged).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ).pipe(Effect.provide(gitLayer)),
  );

  it.live("classifies a duplicated checkout as repair-required without rewriting it", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        yield* ensureEnvironment(workspace.primary);
        const duplicatePath = `${workspace.root}/duplicate`;
        cpSync(workspace.primary, duplicatePath, { recursive: true });
        const report = yield* discoverEnvironment(duplicatePath);
        expect(report.state).toBe("needsRepair");
        if (report.state !== "needsRepair") throw new Error("expected duplicate checkout");
        expect(report.reason).toBe("duplicate");
        const repair = yield* validateEnvironmentRepair(report.repair).pipe(Effect.exit);
        expect(Exit.isFailure(repair)).toBe(true);
        const after = yield* discoverEnvironment(duplicatePath);
        expect(after.state).toBe("needsRepair");
      }),
    ).pipe(Effect.provide(gitLayer)),
  );
});
