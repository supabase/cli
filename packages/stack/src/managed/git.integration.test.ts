import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  git,
  makeBareRepository,
  makeDirectory,
  makeRepository,
  temporaryRoots,
} from "../../tests/helpers/git-workspace.ts";
import {
  ensureGitCheckoutIdentity,
  gitConfigStoreLayer,
  inspectWorkspace,
  type GitCheckoutInspection,
} from "./git.ts";
import { UnsupportedGitWorkspaceError } from "./model.ts";

const { makeRoot, removeAll } = temporaryRoots("managed-git-test-");
const gitLayer = Layer.mergeAll(BunFileSystem.layer, gitConfigStoreLayer);

afterEach(removeAll);

const inspectCheckout = (
  path: string,
): Effect.Effect<GitCheckoutInspection, UnsupportedGitWorkspaceError, FileSystem.FileSystem> =>
  Effect.flatMap(inspectWorkspace(path), (inspection) =>
    inspection.kind === "git-checkout"
      ? Effect.succeed(inspection)
      : Effect.die(new Error(`${path} was classified as ${inspection.kind}`)),
  );

describe("managed Git workspace identity", () => {
  it.live("distinguishes an ordinary folder from a nested primary checkout", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const folder = makeDirectory(root, "folder");
      const repository = makeRepository(root);
      const nested = makeDirectory(repository, join("src", "nested"));

      expect(yield* inspectWorkspace(folder)).toMatchObject({ kind: "ordinary-folder" });
      const checkout = yield* inspectCheckout(nested);
      expect(checkout).toMatchObject({
        checkoutKind: "primary",
        workspaceRoot: repository,
        head: { kind: "branch", branch: "main" },
      });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("reports detached HEAD without inventing a branch context", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const commit = git(repository, "rev-parse", "HEAD").trim();
      git(repository, "checkout", "-q", commit);

      expect((yield* inspectCheckout(repository)).head).toEqual({ kind: "detached", commit });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("fails loudly for dangling metadata and Git-internal paths", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const dangling = makeDirectory(root, "dangling");
      writeFileSync(join(dangling, ".git"), `gitdir: ${join(root, "missing")}\n`);
      const repository = makeRepository(root);
      makeBareRepository(root, repository);

      for (const path of [dangling, join(repository, ".git"), join(root, "bare.git")]) {
        const failure = yield* Effect.flip(inspectWorkspace(path));
        expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      }
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("gives sibling worktrees one project and independent checkout identities", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const firstPath = join(root, "first");
      const secondPath = join(root, "second");
      git(repository, "worktree", "add", "-q", firstPath, "-b", "feature/first");
      git(repository, "worktree", "add", "-q", secondPath, "-b", "feature/second");

      const [primary, first, second] = yield* Effect.all([
        inspectCheckout(repository),
        inspectCheckout(firstPath),
        inspectCheckout(secondPath),
      ]);
      const identities = yield* Effect.all(
        [primary, first, second].map((checkout) => ensureGitCheckoutIdentity(checkout)),
        { concurrency: "unbounded" },
      );

      expect(new Set(identities.map((identity) => identity.projectId)).size).toBe(1);
      expect(new Set(identities.map((identity) => identity.checkoutId)).size).toBe(3);
      expect(first.checkoutKind).toBe("linked-worktree");
      expect(second.checkoutKind).toBe("linked-worktree");
    }).pipe(Effect.provide(gitLayer)),
  );
});
