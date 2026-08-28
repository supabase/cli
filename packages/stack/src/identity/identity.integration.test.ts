import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { deriveStackId, resolveStackIdentity, type StackIdentity } from "./Identity.ts";

const platformLayer = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer);

type PlatformServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path;

const run = <A, E>(effect: Effect.Effect<A, E, PlatformServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(platformLayer)));

const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
};

const makeGitWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "supabase-stack-identity-"));
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "stack-tests@example.test");
  git(repository, "config", "user.name", "Stack Tests");
  await writeFile(join(repository, "README.md"), "identity\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return { root, repository };
};

const cleanup = (root: string) => rm(root, { recursive: true, force: true });

const stackId = async (identity: StackIdentity): Promise<StackId> => run(deriveStackId(identity));

describe("deterministic stack identity and state paths", () => {
  it("repeats the same identity and isolates explicit stack names", async () => {
    const { root, repository } = await makeGitWorkspace();
    try {
      const first = await run(resolveStackIdentity({ projectRoot: repository }));
      const repeat = await run(resolveStackIdentity({ projectRoot: repository }));
      const named = await run(resolveStackIdentity({ projectRoot: repository, name: "preview" }));

      expect(repeat).toEqual(first);
      expect(await stackId(first)).toBe(await stackId(repeat));
      expect(first.stackName).toBe("default");
      expect(named.stackName).toBe("preview");
      expect(await stackId(named)).not.toBe(await stackId(first));
    } finally {
      await cleanup(root);
    }
  });

  it("derives the documented digest from length-delimited UTF-8 tuple fields", async () => {
    const identity: StackIdentity = {
      projectRoot: "/tmp/project",
      checkoutRoot: "/tmp/checkout",
      workspaceId: "workspace",
      checkoutId: "checkout",
      branchContext: "refs/heads/main",
      localProjectKey: ".",
      stackName: "default",
    };

    expect(await stackId(identity)).toBe(
      "c4c6587af0cd4fb3e5dab47a532023ba81cf1cd24e35b5173634a4539e8dab0f",
    );
  });

  it("returns to the same identity after changing away from and back to a branch", async () => {
    const { root, repository } = await makeGitWorkspace();
    try {
      const main = await run(resolveStackIdentity({ projectRoot: repository }));
      git(repository, "checkout", "-b", "feature/deploy");
      const feature = await run(resolveStackIdentity({ projectRoot: repository }));
      git(repository, "checkout", "main");
      const mainAgain = await run(resolveStackIdentity({ projectRoot: repository }));

      expect(main.branchContext).toBe("refs/heads/main");
      expect(feature.branchContext).toBe("refs/heads/feature/deploy");
      expect(await stackId(feature)).not.toBe(await stackId(main));
      expect(await stackId(mainAgain)).toBe(await stackId(main));
    } finally {
      await cleanup(root);
    }
  });

  it("keeps sibling worktrees distinct while sharing the common repository identity", async () => {
    const { root, repository } = await makeGitWorkspace();
    const sibling = join(root, "sibling");
    try {
      git(repository, "worktree", "add", "--force", sibling, "main");
      const primary = await run(resolveStackIdentity({ projectRoot: repository }));
      const linked = await run(resolveStackIdentity({ projectRoot: sibling }));

      expect(linked.workspaceId).toBe(primary.workspaceId);
      expect(linked.checkoutId).not.toBe(primary.checkoutId);
      expect(linked.branchContext).toBe(primary.branchContext);
      expect(await stackId(linked)).not.toBe(await stackId(primary));
    } finally {
      await cleanup(root);
    }
  });

  it("uses detached as the branch context for a detached checkout", async () => {
    const { root, repository } = await makeGitWorkspace();
    try {
      git(repository, "checkout", "--detach", "HEAD");
      const identity = await run(resolveStackIdentity({ projectRoot: repository }));

      expect(identity.branchContext).toBe("detached");
    } finally {
      await cleanup(root);
    }
  });

  it("normalizes a nested project root relative to its checkout", async () => {
    const { root, repository } = await makeGitWorkspace();
    const nested = join(repository, "apps", "web");
    try {
      await mkdir(nested, { recursive: true });
      const identity = await run(resolveStackIdentity({ projectRoot: nested }));

      expect(identity.projectRoot).toBe(await realpath(nested));
      expect(identity.localProjectKey).toBe("apps/web");
    } finally {
      await cleanup(root);
    }
  });

  it("uses canonical ordinary-folder identity without writing discovery markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-stack-ordinary-"));
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      const before = await readdir(project);
      const identity = await run(resolveStackIdentity({ projectRoot: project }));
      const after = await readdir(project);

      expect(identity.workspaceId).toBe(identity.projectRoot);
      expect(identity.checkoutId).toBe(identity.projectRoot);
      expect(identity.branchContext).toBe("ordinary-workspace");
      expect(identity.localProjectKey).toBe(".");
      expect(after).toEqual(before);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects non-digest ids and keeps every state path below the exact identity root", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-stack-paths-"));
    const stateRoot = join(root, "state");
    const project = join(root, "project");
    try {
      await mkdir(stateRoot, { recursive: true });
      await mkdir(project, { recursive: true });
      const identity = await run(resolveStackIdentity({ projectRoot: project }));
      const id = await stackId(identity);
      const paths = await run(resolveStackPaths({ stateRoot, stackId: id }));

      expect(paths.stackRoot).toBe(join(stateRoot, id));
      expect(paths.stateDocument).toBe(join(stateRoot, id, "state.json"));
      for (const value of Object.values(paths)) {
        const child = relative(paths.stackRoot, value);
        expect(child === "" || (child !== ".." && !child.startsWith(`..${sep}`))).toBe(true);
      }

      const invalid = await Effect.runPromiseExit(
        Schema.decodeUnknownEffect(StackIdSchema)("stack_local"),
      );
      expect(Exit.isFailure(invalid)).toBe(true);
      const unsafe = await Effect.runPromiseExit(
        resolveStackPaths({ stateRoot, stackId: "../outside" as StackId }).pipe(
          Effect.provide(platformLayer),
        ),
      );
      expect(Exit.isFailure(unsafe)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("reads linked-worktree metadata through the filesystem without relying on git", async () => {
    const { root, repository } = await makeGitWorkspace();
    const sibling = join(root, "sibling");
    try {
      git(repository, "worktree", "add", "--force", sibling, "main");
      const gitEntry = await readFile(join(sibling, ".git"), "utf8");
      expect(gitEntry).toContain("gitdir:");
      const identity = await run(resolveStackIdentity({ projectRoot: sibling }));
      expect(identity.checkoutId).not.toBe(identity.workspaceId);
    } finally {
      await cleanup(root);
    }
  });
});
