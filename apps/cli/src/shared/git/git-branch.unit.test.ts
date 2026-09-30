import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { detectGitBranch } from "./git-branch.ts";

function withCwd(cwd: string, env: Record<string, string> = {}) {
  return Layer.mergeAll(
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
    Layer.succeed(RuntimeInfo, {
      cwd,
      platform: process.platform,
      arch: process.arch,
      homeDir: cwd,
      execPath: process.execPath,
      pid: process.pid,
    }),
  );
}

const makeTempDir = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

const writeHead = Effect.fnUntraced(function* (root: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(root, ".git"));
  yield* fs.writeFileString(path.join(root, ".git", "HEAD"), contents);
});

describe("detectGitBranch", () => {
  it.live("returns $GITHUB_HEAD_REF when set", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir("git-branch-ci-");
      const got = yield* detectGitBranch().pipe(
        Effect.provide(withCwd(root, { GITHUB_HEAD_REF: "ci-branch" })),
      );
      expect(got).toEqual(Option.some("ci-branch"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("ignores an empty $GITHUB_HEAD_REF and falls back to .git/HEAD", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir("git-branch-empty-ref-");
      yield* writeHead(root, "ref: refs/heads/feature-x\n");
      const got = yield* detectGitBranch().pipe(
        Effect.provide(withCwd(root, { GITHUB_HEAD_REF: "" })),
      );
      expect(got).toEqual(Option.some("feature-x"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("parses ref: refs/heads/<name> from .git/HEAD in CWD", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir("git-branch-");
      yield* writeHead(root, "ref: refs/heads/feature-x\n");
      const got = yield* detectGitBranch().pipe(Effect.provide(withCwd(root)));
      expect(got).toEqual(Option.some("feature-x"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("walks up parent directories until .git/HEAD is found", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir("git-branch-walk-");
      const nested = path.join(root, "a", "b", "c");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* writeHead(root, "ref: refs/heads/main\n");
      const got = yield* detectGitBranch().pipe(Effect.provide(withCwd(nested)));
      expect(got).toEqual(Option.some("main"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("returns none when no .git/HEAD is ever found", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir("git-branch-none-");
      const got = yield* detectGitBranch().pipe(Effect.provide(withCwd(root)));
      expect(Option.isNone(got)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("returns none when .git/HEAD points at a detached commit (no ref: line)", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir("git-branch-detached-");
      yield* writeHead(root, "deadbeef\n");
      const got = yield* detectGitBranch().pipe(Effect.provide(withCwd(root)));
      expect(Option.isNone(got)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("walks from an explicit startDir instead of the runtime CWD", () =>
    Effect.gen(function* () {
      // The project repo (with .git/HEAD) is the startDir; the runtime CWD is an
      // unrelated dir with no repo, mirroring `supabase --workdir <project>` run
      // from elsewhere.
      const project = yield* makeTempDir("git-branch-workdir-");
      yield* writeHead(project, "ref: refs/heads/project-branch\n");
      const elsewhere = yield* makeTempDir("git-branch-cwd-");
      const got = yield* detectGitBranch(project).pipe(Effect.provide(withCwd(elsewhere)));
      expect(got).toEqual(Option.some("project-branch"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
