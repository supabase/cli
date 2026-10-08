import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The scheduled API sync only rewrites this package, and the project-config mirror lives in
// @supabase/config, so apps/cli's type-level drift guards only run on a PR touching either if turbo
// folds that package's files into the dependent's cached `types:check` hash via `transit`.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(scriptDir, "..");
const repoDir = path.join(packageDir, "..", "..");
const turboBin = path.join(repoDir, "node_modules", ".bin", "turbo");

type DryRunTask = { readonly taskId: string; readonly dependencies: ReadonlyArray<string> };

function dryRunTypesCheckForDependents(packageName: string): ReadonlyArray<DryRunTask> {
  // Redirects stdout to a file: Bun on Linux truncates a child's piped stdout at ~219 KB, and
  // the dry-run JSON lists every hashed input file.
  const tempDir = mkdtempSync(path.join(tmpdir(), "turbo-dry-run-"));
  try {
    const outputPath = path.join(tempDir, "dry-run.json");
    const fd = openSync(outputPath, "w");
    try {
      execFileSync(turboBin, ["run", "types:check", `--filter=...${packageName}`, "--dry=json"], {
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
  test.each(["@supabase/api", "@supabase/config"])(
    "includes %s's files for every workspace that depends on it",
    (packageName) => {
      const tasks = dryRunTypesCheckForDependents(packageName);
      const dependentTypesChecks = tasks
        .map((task) => task.taskId)
        .filter(
          (taskId) => taskId.endsWith("#types:check") && !taskId.startsWith(`${packageName}#`),
        );

      expect(dependentTypesChecks).toContain("supabase#types:check");
      for (const taskId of dependentTypesChecks) {
        expect(reachableTaskIds(tasks, taskId), taskId).toContain(`${packageName}#transit`);
      }
    },
    60_000,
  );
});
