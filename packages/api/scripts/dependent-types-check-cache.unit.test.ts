import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The scheduled API sync only rewrites this package, so a dependent's type-level drift guards
// (e.g. apps/cli's project-config mirror check) only run on the sync PR if turbo folds this
// package's files into the dependent's cached `types:check` hash, via the `transit` task chain.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(scriptDir, "..");
const repoDir = path.join(packageDir, "..", "..");
const turboBin = path.join(repoDir, "node_modules", ".bin", "turbo");

type DryRunTask = { readonly taskId: string; readonly dependencies: ReadonlyArray<string> };

function dryRunTypesCheckForDependents(): ReadonlyArray<DryRunTask> {
  // Redirects stdout to a file: Bun on Linux truncates a child's piped stdout at ~219 KB, and
  // the dry-run JSON lists every hashed input file.
  const tempDir = mkdtempSync(path.join(tmpdir(), "turbo-dry-run-"));
  try {
    const outputPath = path.join(tempDir, "dry-run.json");
    const fd = openSync(outputPath, "w");
    try {
      execFileSync(turboBin, ["run", "types:check", "--filter=...@supabase/api", "--dry=json"], {
        cwd: repoDir,
        stdio: ["ignore", fd, "pipe"],
      });
    } finally {
      closeSync(fd);
    }
    return JSON.parse(readFileSync(outputPath, "utf8")).tasks;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function reachableTaskIds(tasks: ReadonlyArray<DryRunTask>, from: string): ReadonlySet<string> {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (taskId === undefined || seen.has(taskId)) continue;
    seen.add(taskId);
    pending.push(...(byId.get(taskId)?.dependencies ?? []));
  }
  return seen;
}

describe("dependent types:check cache key", () => {
  test("includes @supabase/api's files for every workspace that depends on it", () => {
    const tasks = dryRunTypesCheckForDependents();
    const dependentTypesChecks = tasks
      .map((task) => task.taskId)
      .filter((taskId) => taskId.endsWith("#types:check") && !taskId.startsWith("@supabase/api#"));

    expect(dependentTypesChecks).toContain("supabase#types:check");
    for (const taskId of dependentTypesChecks) {
      expect(reachableTaskIds(tasks, taskId), taskId).toContain("@supabase/api#transit");
    }
  }, 60_000);
});
