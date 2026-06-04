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
      const got = yield* detectGitBranch;
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
      const got = yield* detectGitBranch;
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
      const got = yield* detectGitBranch;
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
      const got = yield* detectGitBranch;
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
      const got = yield* detectGitBranch;
      try {
        expect(Option.isNone(got)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (original5 !== undefined) process.env["GITHUB_HEAD_REF"] = original5;
      }
    }).pipe(Effect.provide(withCwd(root)));
  });
});
