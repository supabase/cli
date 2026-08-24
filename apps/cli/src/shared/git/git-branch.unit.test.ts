import { tmpdir } from "node:os";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { detectGitBranch } from "./git-branch.ts";

function withCwd(cwd: string, env: Record<string, string> = {}) {
  return Layer.mergeAll(
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env, preserveEmptyStrings: true })),
    Layer.succeed(RuntimeInfo, {
      cwd,
      platform: process.platform,
      arch: process.arch,
      homeDir: tmpdir(),
      execPath: process.execPath,
      pid: process.pid,
    }),
  );
}

const makeTempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
  });

const removeTempDirectory = (root: string, _exit: Exit.Exit<unknown, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
  });

const acquireTempDirectory = (prefix: string) =>
  Effect.acquireRelease(makeTempDirectory(prefix), removeTempDirectory);

describe("detectGitBranch", () => {
  it.live("returns $GITHUB_HEAD_REF when set", () => {
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      expect(Option.isSome(got)).toBe(true);
      if (Option.isSome(got)) expect(got.value).toBe("ci-branch");
    }).pipe(Effect.provide(withCwd(tmpdir(), { GITHUB_HEAD_REF: "ci-branch" })));
  });

  it.live("parses ref: refs/heads/<name> from .git/HEAD in the start directory", () => {
    return Effect.gen(function* () {
      const root = yield* acquireTempDirectory("git-branch-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.writeFileString(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
      const got = yield* detectGitBranch(root);
      expect(Option.isSome(got)).toBe(true);
      if (Option.isSome(got)) expect(got.value).toBe("feature-x");
    }).pipe(Effect.provide(withCwd(tmpdir())));
  });

  it.live("walks up parent directories until .git/HEAD is found", () => {
    return Effect.gen(function* () {
      const root = yield* acquireTempDirectory("git-branch-walk-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const nested = path.join(root, "a", "b", "c");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.writeFileString(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      const got = yield* detectGitBranch(nested);
      expect(Option.isSome(got)).toBe(true);
      if (Option.isSome(got)) expect(got.value).toBe("main");
    }).pipe(Effect.provide(withCwd(tmpdir())));
  });

  it.live("returns none when no .git/HEAD is ever found and the env value is empty", () => {
    return Effect.gen(function* () {
      const root = yield* acquireTempDirectory("git-branch-empty-");
      const got = yield* detectGitBranch(root);
      expect(Option.isNone(got)).toBe(true);
    }).pipe(Effect.provide(withCwd(tmpdir(), { GITHUB_HEAD_REF: "" })));
  });

  it.live("returns none when .git/HEAD points at a detached commit (no ref: line)", () => {
    return Effect.gen(function* () {
      const root = yield* acquireTempDirectory("git-branch-detached-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.writeFileString(path.join(root, ".git", "HEAD"), "deadbeef\n");
      const got = yield* detectGitBranch(root);
      expect(Option.isNone(got)).toBe(true);
    }).pipe(Effect.provide(withCwd(tmpdir())));
  });

  it.live("walks from an explicit startDir instead of the runtime CWD", () => {
    return Effect.gen(function* () {
      // The project repo (with .git/HEAD) is the startDir; the runtime CWD is an
      // unrelated dir with no repo, mirroring `supabase --workdir <project>` run
      // from elsewhere.
      const project = yield* acquireTempDirectory("git-branch-workdir-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(project, ".git"));
      yield* fs.writeFileString(
        path.join(project, ".git", "HEAD"),
        "ref: refs/heads/project-branch\n",
      );
      const got = yield* detectGitBranch(project);
      expect(Option.isSome(got)).toBe(true);
      if (Option.isSome(got)) expect(got.value).toBe("project-branch");
    }).pipe(Effect.provide(withCwd(tmpdir())));
  });
});
