// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/unnecessary-effect-gen -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect";
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
import { InvalidManagedIdentityError, UnsupportedGitWorkspaceError } from "./model.ts";

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

  it.live("cleans an ordinary identity temp after interruption races exclusive open", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const workspace = makeDirectory(root, "workspace");
      const markerPath = join(workspace, ".supabase", "identity.json");
      let tempOpenBlocked = false;
      const layer = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          open: (path, options) => {
            if (
              !tempOpenBlocked &&
              path.startsWith(`${markerPath}.tmp.`) &&
              options?.flag === "wx"
            ) {
              tempOpenBlocked = true;
              return fs
                .open(path, options)
                .pipe(Effect.flatMap((file) => Effect.interrupt.pipe(Effect.as(file))));
            }
            return fs.open(path, options);
          },
        })),
      ).pipe(Layer.provide(BunFileSystem.layer));

      const interrupted = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(interrupted)).toBe(true);

      const fs = yield* Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      }).pipe(Effect.provide(layer));
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect(yield* fs.readDirectory(join(workspace, ".supabase"))).toEqual([]);

      const retry = yield* ensureOrdinaryWorkspaceIdentity(workspace).pipe(Effect.provide(layer));
      expect(retry.created).toBe(true);
    }),
  );

  it.live("fails with a typed error when hard-link publication is unsupported", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const repository = makeRepository(root);
      const checkout = yield* inspectCheckout(repository).pipe(Effect.provide(gitLayer));
      const markerPath = join(checkout.gitDirectory, "supabase-checkout.json");
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
        })),
      );
      const providedLayer = Layer.mergeAll(
        layer.pipe(Layer.provide(BunFileSystem.layer)),
        gitConfigStoreLayer,
      );

      const failure = yield* Effect.flip(
        ensureGitCheckoutIdentity(checkout).pipe(Effect.provide(providedLayer)),
      );
      expect(failure).toBeInstanceOf(UnsupportedGitWorkspaceError);
      const fs = yield* Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      }).pipe(Effect.provide(providedLayer));
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect(
        (yield* fs.readDirectory(checkout.gitDirectory)).filter((entry) =>
          entry.startsWith("supabase-checkout.json.tmp."),
        ),
      ).toEqual([]);

      const workspace = makeDirectory(root, "ordinary");
      const ordinaryFailure = yield* Effect.flip(
        ensureOrdinaryWorkspaceIdentity(workspace).pipe(Effect.provide(providedLayer)),
      );
      expect(ordinaryFailure).toBeInstanceOf(InvalidManagedIdentityError);
      expect(ordinaryFailure.message).toContain("hard links");
      const ordinaryMetadata = join(workspace, ".supabase");
      expect(yield* fs.exists(join(ordinaryMetadata, "identity.json"))).toBe(false);
      expect(yield* fs.readDirectory(ordinaryMetadata)).toEqual([]);
    }),
  );
});
