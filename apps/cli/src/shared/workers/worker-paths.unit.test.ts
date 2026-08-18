import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import {
  displayPath,
  resolveWorkerSource,
  inferWorkerNameFromCwd,
  resolveWorkersRoot,
  workerDir,
  workerSourceDir,
  workersRootDir,
} from "./worker-paths.ts";
import { InvalidWorkerSourceError, InvalidWorkersRootError } from "./workers.errors.ts";

const PROJECT = "/repo";

function rootOf(configured: string | undefined) {
  return Effect.runSyncExit(resolveWorkersRoot(configured));
}

function rootValue(configured: string | undefined): string {
  const exit = rootOf(configured);
  if (!Exit.isSuccess(exit)) {
    throw new Error(`expected a root for ${String(configured)}`);
  }
  return exit.value;
}

describe("resolveWorkersRoot", () => {
  test("defaults to workers/ and accepts a plain directory name", () => {
    expect(rootValue(undefined)).toBe("workers");
    expect(rootValue("services")).toBe("services");
    expect(rootValue("services/")).toBe("services");
    expect(rootValue("nested/services")).toBe(join("nested", "services"));
  });

  test.each([
    ["", "supabase/ itself"],
    [".", "supabase/ itself"],
    ["/etc", "an absolute path"],
    ["../elsewhere", "a climb out of supabase/"],
    ["functions", "a directory the CLI owns"],
    ["migrations", "a directory the CLI owns"],
  ])("refuses %j — %s", (configured) => {
    const error = Effect.runSync(resolveWorkersRoot(configured).pipe(Effect.flip));
    expect(error).toBeInstanceOf(InvalidWorkersRootError);
    expect(error.suggestion).toContain('root = "services"');
  });
});

describe("worker directories", () => {
  test("resolve under supabase/<root>/", () => {
    expect(workersRootDir(PROJECT, "workers")).toBe(join(PROJECT, "supabase", "workers"));
    expect(workerDir(PROJECT, "services", "api")).toBe(
      join(PROJECT, "supabase", "services", "api"),
    );
  });

  test("a recorded source wins and is anchored to the project root", () => {
    const fallback = workerDir(PROJECT, "workers", "api");
    expect(workerSourceDir(PROJECT, fallback, undefined)).toBe(fallback);
    expect(workerSourceDir(PROJECT, fallback, "")).toBe(fallback);
    expect(workerSourceDir(PROJECT, fallback, "packages/api")).toBe(
      join(PROJECT, "packages", "api"),
    );
  });
});

describe("inferWorkerNameFromCwd", () => {
  const rootDir = join(PROJECT, "supabase", "workers");

  test("names the worker when cwd is exactly one level under the root", () => {
    expect(inferWorkerNameFromCwd(join(rootDir, "api"), rootDir)).toBe("api");
  });

  test("declines the root itself, a nested subdirectory, and anywhere outside", () => {
    expect(inferWorkerNameFromCwd(rootDir, rootDir)).toBeUndefined();
    expect(inferWorkerNameFromCwd(join(rootDir, "api", "src"), rootDir)).toBeUndefined();
    expect(inferWorkerNameFromCwd(join(PROJECT, "elsewhere", "api"), rootDir)).toBeUndefined();
  });

  test("does not fire on a same-named directory elsewhere in the tree", () => {
    expect(inferWorkerNameFromCwd("/other/supabase/workers/api", rootDir)).toBeUndefined();
  });
});

describe("displayPath", () => {
  test("prefers the relative form, and falls back to absolute when it would climb out", () => {
    expect(displayPath(PROJECT, join(PROJECT, "supabase", "workers", "api"))).toBe(
      join("supabase", "workers", "api"),
    );
    expect(displayPath(PROJECT, PROJECT)).toBe(".");
    expect(displayPath(join(PROJECT, "deep", "deeper"), "/elsewhere/api")).toBe("/elsewhere/api");
  });
});

describe("resolveWorkerSource", () => {
  const cwd = `${PROJECT}/apps/web`;

  test("resolves a directory inside the project against the directory it was typed in", () => {
    expect(
      Effect.runSync(resolveWorkerSource({ projectRoot: PROJECT, cwd, raw: "../../packages/api" })),
    ).toBe(join(PROJECT, "packages", "api"));
    expect(
      Effect.runSync(
        resolveWorkerSource({ projectRoot: PROJECT, cwd: PROJECT, raw: "packages/api/" }),
      ),
    ).toBe(join(PROJECT, "packages", "api"));
  });

  // `--force` deletes whatever this resolves to, so each of these would destroy
  // work belonging to the project or to the machine.
  test.each([
    [".", "the project root itself"],
    ["", "empty"],
    ["..", "outside the project"],
    ["/etc", "outside the project"],
    ["../elsewhere", "outside the project"],
    ["supabase", "the supabase directory itself"],
    ["supabase/functions", "supabase/functions/"],
    ["supabase/functions/hello", "supabase/functions/"],
    ["supabase/migrations", "supabase/migrations/"],
  ])("refuses %j", (raw, reason) => {
    const error = Effect.runSync(
      resolveWorkerSource({ projectRoot: PROJECT, cwd: PROJECT, raw }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(InvalidWorkerSourceError);
    expect(error.detail).toContain(reason);
  });
});
