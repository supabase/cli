import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, FileSystem, Fiber, Layer, PlatformError } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
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
import { ensureOrdinaryWorkspaceIdentity } from "./identity.ts";
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

  it.live("rejects a repository configured for reftable refs", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      git(repository, "config", "extensions.refStorage", "reftable");

      const failure = yield* Effect.flip(inspectWorkspace(repository));
      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      expect(failure).toMatchObject({ workspaceCause: "reftable" });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("parses quoted plain config values and ignores subsections", () =>
    Effect.gen(function* () {
      const repository = makeRepository(makeRoot());
      const configPath = join(repository, ".git", "config");
      writeFileSync(
        configPath,
        `${readFileSync(configPath, "utf8")}
[extensions "unrelated"]
  refStorage = reftable
[extensions]
  refStorage = "files"
[core "unrelated"]
  bare = true
[core]
  bare = "false"
`,
      );
      const checkout = yield* inspectCheckout(repository);
      expect(checkout.checkoutKind).toBe("primary");
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

      expect(new Set(identities.map((identity) => identity.workspaceId)).size).toBe(1);
      expect(new Set(identities.map((identity) => identity.checkoutId)).size).toBe(3);
      expect(first.checkoutKind).toBe("linked-worktree");
      expect(second.checkoutKind).toBe("linked-worktree");
      const thirdPath = join(root, "third");
      git(repository, "worktree", "add", "-q", thirdPath, "-b", "feature/third");
      const third = yield* inspectCheckout(thirdPath);
      const raced = yield* Effect.all(
        [ensureGitCheckoutIdentity(third), ensureGitCheckoutIdentity(third)],
        { concurrency: "unbounded" },
      );
      expect(new Set(raced.map((identity) => identity.checkoutId)).size).toBe(1);
      expect(raced.filter((identity) => identity.checkoutIdentityCreated)).toHaveLength(1);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.live("converges ordinary identity claims after unsupported-link publication", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const workspace = makeDirectory(root, "workspace");
      const markerPath = join(workspace, ".supabase", "identity.json");
      const lockPath = `${markerPath}.lock`;
      const renameStarted = yield* Deferred.make<void>();
      const secondLockAttempted = yield* Deferred.make<void>();
      const allowRename = yield* Deferred.make<void>();
      let renameBlocked = false;
      let lockAttempts = 0;
      const layer = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          link: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "link",
                cause: Object.assign(new Error("hard links unavailable"), { code: "EPERM" }),
              }),
            ),
          open: (path, options) => {
            if (path === lockPath && options?.flag === "wx") {
              lockAttempts += 1;
              if (lockAttempts === 2)
                return Deferred.succeed(secondLockAttempted, undefined).pipe(
                  Effect.andThen(fs.open(path, options)),
                );
            }
            return fs.open(path, options);
          },
          rename: (fromPath, toPath) => {
            if (!renameBlocked && toPath === markerPath) {
              renameBlocked = true;
              return Deferred.succeed(renameStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowRename)),
                Effect.andThen(fs.rename(fromPath, toPath)),
              );
            }
            return fs.rename(fromPath, toPath);
          },
        })),
      ).pipe(Layer.provide(BunFileSystem.layer));

      const first = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(renameStarted);
      const second = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(secondLockAttempted);
      const fs = yield* Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      }).pipe(Effect.provide(layer));
      expect(yield* fs.exists(markerPath)).toBe(false);
      yield* Deferred.succeed(allowRename, undefined);
      const identities = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(identities[0].identity).toEqual(identities[1].identity);
      expect(identities.filter((identity) => identity.created)).toHaveLength(1);
      expect(yield* fs.readDirectory(join(workspace, ".supabase"))).toEqual(["identity.json"]);
    }),
  );

  it.live("cleans unsupported-link publication on interruption before retry", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const workspace = makeDirectory(root, "workspace");
      const markerPath = join(workspace, ".supabase", "identity.json");
      const renameStarted = yield* Deferred.make<void>();
      const allowRename = yield* Deferred.make<void>();
      let renameBlocked = false;
      const layer = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          link: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "link",
                cause: Object.assign(new Error("hard links unavailable"), { code: "EPERM" }),
              }),
            ),
          rename: (fromPath, toPath) => {
            if (!renameBlocked && toPath === markerPath) {
              renameBlocked = true;
              return Deferred.succeed(renameStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowRename)),
                Effect.andThen(fs.rename(fromPath, toPath)),
              );
            }
            return fs.rename(fromPath, toPath);
          },
        })),
      ).pipe(Layer.provide(BunFileSystem.layer));

      const first = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(renameStarted);
      yield* Fiber.interrupt(first);
      const interrupted = yield* Fiber.join(first).pipe(Effect.exit);
      expect(Exit.isFailure(interrupted)).toBe(true);
      const fs = yield* Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      }).pipe(Effect.provide(layer));
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect(yield* fs.readDirectory(join(workspace, ".supabase"))).toEqual([]);

      yield* Deferred.succeed(allowRename, undefined);
      const retry = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(Effect.provide(layer));
      expect(retry.created).toBe(true);
      expect(yield* fs.readFileString(markerPath)).toContain(retry.identity.workspaceId);
    }),
  );
});
