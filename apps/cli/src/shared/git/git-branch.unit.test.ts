import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { detectGitBranch } from "./git-branch.ts";

function withCwd(cwd: string) {
  return Layer.mergeAll(
    BunServices.layer,
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

describe("detectGitBranch", () => {
  let original: string | undefined;

  it.live("returns $GITHUB_HEAD_REF when set", () => {
    original = process.env["GITHUB_HEAD_REF"];
    process.env["GITHUB_HEAD_REF"] = "ci-branch";
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("ci-branch");
      } finally {
        if (original === undefined) delete process.env["GITHUB_HEAD_REF"];
        else process.env["GITHUB_HEAD_REF"] = original;
      }
    }).pipe(Effect.provide(withCwd(tmpdir())));
  });

  it.live("parses ref: refs/heads/<name> from .git/HEAD in CWD", () => {
    const original2 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const root = mkdtempSync(join(tmpdir(), "git-branch-"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("feature-x");
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original2 !== undefined) process.env["GITHUB_HEAD_REF"] = original2;
      }
    }).pipe(Effect.provide(withCwd(root)));
  });

  it.live("walks up parent directories until .git/HEAD is found", () => {
    const original3 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const root = mkdtempSync(join(tmpdir(), "git-branch-walk-"));
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("main");
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original3 !== undefined) process.env["GITHUB_HEAD_REF"] = original3;
      }
    }).pipe(Effect.provide(withCwd(nested)));
  });

  it.live("returns none when no .git/HEAD is ever found", () => {
    const original4 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const root = mkdtempSync(join(tmpdir(), "git-branch-empty-"));
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isNone(got)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original4 !== undefined) process.env["GITHUB_HEAD_REF"] = original4;
      }
    }).pipe(Effect.provide(withCwd(root)));
  });

  it.live("returns none when .git/HEAD points at a detached commit (no ref: line)", () => {
    const original5 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const root = mkdtempSync(join(tmpdir(), "git-branch-detached-"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "deadbeef\n");
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isNone(got)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original5 !== undefined) process.env["GITHUB_HEAD_REF"] = original5;
      }
    }).pipe(Effect.provide(withCwd(root)));
  });

  it.live("resolves a worktree's `.git` gitlink file to its own HEAD", () => {
    const original7 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    // Mirrors `git worktree add`: the worktree's `.git` is a FILE pointing at the
    // real gitdir, nested under the main checkout's `.git/worktrees/<name>`.
    const main = mkdtempSync(join(tmpdir(), "git-branch-main-"));
    mkdirSync(join(main, ".git"));
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/develop\n");
    const worktreeGitDir = join(main, ".git", "worktrees", "feature");
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature-x\n");
    const worktree = mkdtempSync(join(tmpdir(), "git-branch-worktree-"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("feature-x");
      } finally {
        rmSync(main, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
        if (original7 !== undefined) process.env["GITHUB_HEAD_REF"] = original7;
      }
    }).pipe(Effect.provide(withCwd(worktree)));
  });

  it.live("resolves a relative gitdir in a `.git` gitlink against its directory", () => {
    const original8 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const root = mkdtempSync(join(tmpdir(), "git-branch-relative-"));
    const gitDir = join(root, "actual-gitdir");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/relative-branch\n");
    writeFileSync(join(root, ".git"), "gitdir: ./actual-gitdir\n");
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("relative-branch");
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original8 !== undefined) process.env["GITHUB_HEAD_REF"] = original8;
      }
    }).pipe(Effect.provide(withCwd(root)));
  });

  it.live("stops at the nearest .git instead of a detached HEAD's parent checkout", () => {
    const original9 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    // A parent repo with a real branch must not leak into a nested repo whose own
    // HEAD is detached — the nested `.git` should stop the walk right there.
    const root = mkdtempSync(join(tmpdir(), "git-branch-detached-nested-"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, ".git", "HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
    return Effect.gen(function* () {
      const got = yield* detectGitBranch();
      try {
        expect(Option.isNone(got)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original9 !== undefined) process.env["GITHUB_HEAD_REF"] = original9;
      }
    }).pipe(Effect.provide(withCwd(nested)));
  });

  it.live("walks from an explicit startDir instead of the runtime CWD", () => {
    const original6 = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    // The project repo (with .git/HEAD) is the startDir; the runtime CWD is an
    // unrelated dir with no repo, mirroring `supabase --workdir <project>` run
    // from elsewhere.
    const project = mkdtempSync(join(tmpdir(), "git-branch-workdir-"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/project-branch\n");
    const elsewhere = mkdtempSync(join(tmpdir(), "git-branch-cwd-"));
    return Effect.gen(function* () {
      const got = yield* detectGitBranch(project);
      try {
        expect(Option.isSome(got)).toBe(true);
        if (Option.isSome(got)) expect(got.value).toBe("project-branch");
      } finally {
        rmSync(project, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
        if (original6 !== undefined) process.env["GITHUB_HEAD_REF"] = original6;
      }
    }).pipe(Effect.provide(withCwd(elsewhere)));
  });
});
