import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, Exit, FileSystem, Path, Schema } from "effect";
import { InvalidStackIdentityError } from "../public/Errors.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { GitSetupError, runGit } from "../../tests/helpers/git.ts";
import { deriveStackId, resolveStackIdentity, type StackIdentity } from "./Identity.ts";

const platformLayer = NodeServices.layer;

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
          branchContext: "refs/heads/main",
          stackName: "default",
        };

        expect(yield* stackId(identity)).toBe(
          "64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f",
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

  it.live("keeps sibling worktrees distinct by their canonical project roots", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, repository } = yield* makeGitWorkspace;
        const sibling = path.join(root, "sibling");
        yield* runGit(repository, ["worktree", "add", "--force", sibling, "main"]);
        const primary = yield* resolveStackIdentity({ projectRoot: repository });
        const linked = yield* resolveStackIdentity({ projectRoot: sibling });

        expect(linked.projectRoot).not.toBe(primary.projectRoot);
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

  it.live("rejects a malformed HEAD marker in an otherwise empty git directory", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-git-marker-" });
        const project = path.join(root, "project");
        yield* fs.makeDirectory(path.join(project, ".git"), { recursive: true });
        yield* fs.writeFileString(path.join(project, ".git", "HEAD"), "not-a-commit\n");

        const error = yield* resolveStackIdentity({ projectRoot: project }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidStackIdentityError);
      }),
    ),
  );

  it.live("preserves errors for an explicit gitdir target with missing HEAD", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-gitdir-" });
        const project = path.join(root, "project");
        const gitDirectory = path.join(root, "git-directory");
        yield* fs.makeDirectory(project);
        yield* fs.makeDirectory(path.join(gitDirectory, "objects"), { recursive: true });
        yield* fs.makeDirectory(path.join(gitDirectory, "refs"));
        yield* fs.writeFileString(path.join(project, ".git"), `gitdir: ${gitDirectory}\n`);

        const error = yield* resolveStackIdentity({ projectRoot: project }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidStackIdentityError);
        expect(error.message).toContain("Unable to read HEAD");
      }),
    ),
  );

  it.live("preserves Git exit diagnostics when setup fails", () =>
    withScope(
      Effect.gen(function* () {
        const { repository } = yield* makeGitWorkspace;
        const error = yield* runGit(repository, [
          "rev-parse",
          "--verify",
          "refs/heads/missing",
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(GitSetupError);
        expect(error.exitCode).toBe(128);
        expect(error.stderr).toContain("Needed a single revision");
        expect(error.message).toContain("stderr:");
      }),
    ),
  );

  it.live("uses the canonical nested project root as its identity", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repository } = yield* makeGitWorkspace;
        const nested = path.join(repository, "apps", "web");
        yield* fs.makeDirectory(nested, { recursive: true });
        const identity = yield* resolveStackIdentity({ projectRoot: nested });

        expect(identity.projectRoot).toBe(yield* fs.realPath(nested));
        expect(identity.branchContext).toBe("refs/heads/main");
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

        expect(identity.branchContext).toBe("ordinary-workspace");
        expect(after).toEqual(before);
      }),
    ),
  );

  it.live("ignores a stray ancestor .git directory that is not a repository", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-stray-git-" });
        const project = path.join(root, "project");
        yield* fs.makeDirectory(path.join(root, ".git", "gk"), { recursive: true });
        yield* fs.makeDirectory(project);

        const identity = yield* resolveStackIdentity({ projectRoot: project });

        expect(identity.branchContext).toBe("ordinary-workspace");
      }),
    ),
  );

  it.live("continues past a stray ancestor to find the enclosing repository", () =>
    withScope(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repository } = yield* makeGitWorkspace;
        const container = path.join(repository, "apps");
        const project = path.join(container, "web");
        yield* fs.makeDirectory(path.join(container, ".git", "gk"), { recursive: true });
        yield* fs.makeDirectory(project, { recursive: true });

        const identity = yield* resolveStackIdentity({ projectRoot: project });

        expect(identity.branchContext).toBe("refs/heads/main");
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
