import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Data, Effect, Exit, FileSystem, Path, Schema } from "effect";
import { InvalidStackIdentityError } from "../public/Errors.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { deriveStackId, resolveStackIdentity, type StackIdentity } from "./Identity.ts";

const platformLayer = NodeServices.layer;

class GitSetupError extends Data.TaggedError("GitSetupError")<{
  readonly message: string;
}> {}

const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, GitSetupError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(ChildProcess.make("git", [...args], { cwd }))
      .pipe(Effect.mapError((error) => new GitSetupError({ message: error.message })));
    if (exitCode !== 0) {
      return yield* new GitSetupError({
        message: `git ${args.join(" ")} exited with code ${exitCode}`,
      });
    }
  });

const makeGitWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-identity-" });
  const repository = path.join(root, "repository");
  yield* fs.makeDirectory(repository);
  yield* runGit(repository, ["init", "-b", "main"]);
  yield* runGit(repository, ["config", "user.email", "stack-tests@example.test"]);
  yield* runGit(repository, ["config", "user.name", "Stack Tests"]);
  yield* fs.writeFileString(path.join(repository, "README.md"), "identity\n");
  yield* runGit(repository, ["add", "README.md"]);
  yield* runGit(repository, ["commit", "-m", "initial"]);
  return { root, repository };
});

const stackId = (
  identity: StackIdentity,
): Effect.Effect<StackId, InvalidStackIdentityError, Crypto.Crypto> => deriveStackId(identity);

const withScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(platformLayer));

describe("deterministic stack identity and state paths", () => {
  it.live("repeats the same identity and isolates explicit stack names", () =>
    withScope(
      Effect.gen(function* () {
        const { repository } = yield* makeGitWorkspace;
        const first = yield* resolveStackIdentity({ projectRoot: repository });
        const repeat = yield* resolveStackIdentity({ projectRoot: repository });
        const named = yield* resolveStackIdentity({ projectRoot: repository, name: "preview" });

        expect(repeat).toEqual(first);
        expect(yield* stackId(first)).toBe(yield* stackId(repeat));
        expect(first.stackName).toBe("default");
        expect(named.stackName).toBe("preview");
        expect(yield* stackId(named)).not.toBe(yield* stackId(first));
      }),
    ),
  );

  it.live("preserves leading and trailing spaces in a valid project-root path", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-space-" });
        const project = path.join(root, " project ");
        yield* fs.makeDirectory(project);

        const identity = yield* resolveStackIdentity({ projectRoot: project });
        expect(identity.projectRoot).toBe(yield* fs.realPath(project));
      }),
    ),
  );

  it.live("derives the documented digest from length-delimited UTF-8 tuple fields", () =>
    withScope(
      Effect.gen(function* () {
        const identity: StackIdentity = {
          projectRoot: "/tmp/project",
          checkoutRoot: "/tmp/checkout",
          workspaceId: "workspace",
          checkoutId: "checkout",
          branchContext: "refs/heads/main",
          localProjectKey: ".",
          stackName: "default",
        };

        expect(yield* stackId(identity)).toBe(
          "c4c6587af0cd4fb3e5dab47a532023ba81cf1cd24e35b5173634a4539e8dab0f",
        );
      }),
    ),
  );

  it.live("returns to the same identity after changing away from and back to a branch", () =>
    withScope(
      Effect.gen(function* () {
        const { repository } = yield* makeGitWorkspace;
        const main = yield* resolveStackIdentity({ projectRoot: repository });
        yield* runGit(repository, ["checkout", "-b", "feature/deploy"]);
        const feature = yield* resolveStackIdentity({ projectRoot: repository });
        yield* runGit(repository, ["checkout", "main"]);
        const mainAgain = yield* resolveStackIdentity({ projectRoot: repository });

        expect(main.branchContext).toBe("refs/heads/main");
        expect(feature.branchContext).toBe("refs/heads/feature/deploy");
        expect(yield* stackId(feature)).not.toBe(yield* stackId(main));
        expect(yield* stackId(mainAgain)).toBe(yield* stackId(main));
      }),
    ),
  );

  it.live("keeps sibling worktrees distinct while sharing the common repository identity", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, repository } = yield* makeGitWorkspace;
        const sibling = path.join(root, "sibling");
        yield* runGit(repository, ["worktree", "add", "--force", sibling, "main"]);
        const primary = yield* resolveStackIdentity({ projectRoot: repository });
        const linked = yield* resolveStackIdentity({ projectRoot: sibling });

        expect(linked.workspaceId).toBe(primary.workspaceId);
        expect(linked.checkoutId).not.toBe(primary.checkoutId);
        expect(linked.branchContext).toBe(primary.branchContext);
        expect(yield* stackId(linked)).not.toBe(yield* stackId(primary));
        expect(yield* fs.exists(path.join(sibling, ".git"))).toBe(true);
      }),
    ),
  );

  it.live("uses detached as the branch context for a valid detached checkout", () =>
    withScope(
      Effect.gen(function* () {
        const { repository } = yield* makeGitWorkspace;
        yield* runGit(repository, ["checkout", "--detach", "HEAD"]);
        const identity = yield* resolveStackIdentity({ projectRoot: repository });

        expect(identity.branchContext).toBe("detached");
      }),
    ),
  );

  it.live("rejects symbolic HEAD metadata that does not name a full refs ref", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repository } = yield* makeGitWorkspace;
        yield* fs.writeFileString(path.join(repository, ".git", "HEAD"), "ref: main\n");

        const result = yield* resolveStackIdentity({ projectRoot: repository }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("rejects detached HEAD metadata that is not a Git object id", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repository } = yield* makeGitWorkspace;
        yield* fs.writeFileString(path.join(repository, ".git", "HEAD"), "not-a-commit\n");

        const result = yield* resolveStackIdentity({ projectRoot: repository }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("normalizes a nested project root relative to its checkout", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repository } = yield* makeGitWorkspace;
        const nested = path.join(repository, "apps", "web");
        yield* fs.makeDirectory(nested, { recursive: true });
        const identity = yield* resolveStackIdentity({ projectRoot: nested });

        expect(identity.projectRoot).toBe(yield* fs.realPath(nested));
        expect(identity.localProjectKey).toBe("apps/web");
      }),
    ),
  );

  it.live("uses canonical ordinary-folder identity without writing discovery markers", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-ordinary-" });
        const project = path.join(root, "project");
        yield* fs.makeDirectory(project);
        const before = yield* fs.readDirectory(project);
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const after = yield* fs.readDirectory(project);

        expect(identity.workspaceId).toBe(identity.projectRoot);
        expect(identity.checkoutId).toBe(identity.projectRoot);
        expect(identity.branchContext).toBe("ordinary-workspace");
        expect(identity.localProjectKey).toBe(".");
        expect(after).toEqual(before);
      }),
    ),
  );

  it.live("canonicalizes a symlinked project root before resolving identity", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-symlink-" });
        const target = path.join(root, "target");
        const link = path.join(root, "link");
        yield* fs.makeDirectory(target);
        yield* fs.symlink(target, link);

        const identity = yield* resolveStackIdentity({ projectRoot: link });
        expect(identity.projectRoot).toBe(yield* fs.realPath(target));
      }),
    ),
  );

  it.live("rejects linked-worktree metadata whose commondir target is a file", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, repository } = yield* makeGitWorkspace;
        const sibling = path.join(root, "sibling");
        const notDirectory = path.join(root, "not-a-directory");
        yield* runGit(repository, ["worktree", "add", "--force", sibling, "main"]);
        const gitEntry = yield* fs.readFileString(path.join(sibling, ".git"));
        const target = gitEntry.trim().slice("gitdir:".length).trim();
        const gitDirectory = yield* fs.realPath(path.resolve(sibling, target));
        yield* fs.writeFileString(notDirectory, "not a directory\n");
        yield* fs.writeFileString(path.join(gitDirectory, "commondir"), notDirectory);

        const result = yield* resolveStackIdentity({ projectRoot: sibling }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("rejects non-digest ids and names every state path below the exact identity root", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-paths-" });
        const stateRoot = path.join(root, "state");
        const project = path.join(root, "project");
        yield* fs.makeDirectory(stateRoot);
        yield* fs.makeDirectory(project);
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const id = yield* stackId(identity);
        const paths = yield* resolveStackPaths({ stateRoot, stackId: id });

        expect(paths.stackRoot).toBe(path.join(stateRoot, id));
        expect(paths.stateDocument).toBe(path.join(stateRoot, id, "state.json"));
        expect(paths.data).toBe(path.join(stateRoot, id, "data"));
        expect(paths.logs).toBe(path.join(stateRoot, id, "logs"));
        expect(paths.runtime).toBe(path.join(stateRoot, id, "runtime"));
        expect(paths.controlMetadata).toBe(path.join(stateRoot, id, "control.json"));
        expect(paths.temporaryDirectory).toBe(path.join(stateRoot, id, ".tmp"));
        expect(paths.temporarySibling).toBe(path.join(stateRoot, id, "state.json.tmp"));
        expect(path.dirname(paths.temporarySibling)).toBe(paths.stackRoot);
        for (const value of Object.values(paths)) {
          const relative = path.relative(paths.stackRoot, value);
          expect(
            relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)),
          ).toBe(true);
        }

        const invalid = yield* Schema.decodeEffect(StackIdSchema)("stack_local").pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        const unsafe = yield* resolveStackPaths({
          stateRoot,
          stackId: "../outside" as StackId,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(unsafe)).toBe(true);
      }),
    ),
  );
});
