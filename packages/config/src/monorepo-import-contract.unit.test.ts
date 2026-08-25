import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Enforces the two monorepo-wide import rules from `packages/config/AGENTS.md`
// ("Monorepo import rule"): `@supabase/config/io` has zero internal
// consumers by design (it exists only for external, non-Effect-native
// Node/Bun code), and this package's internals must never be deep-imported
// (only the `.`/`./io`/`./effect` entrypoints are supported import paths).
//
// A plain substring scan (no parsing) is enough for this — it's fast and the
// two forbidden specifiers can't appear by accident. The forbidden strings
// below are built by concatenation so this file's own source can never
// self-match (on top of the directory exclusion below, which already keeps
// this package's `src/` — where those specifier strings legitimately appear
// in test fixtures — out of the walk).
//
// Known limitation: Nx task caching means this only re-runs when
// `packages/config` itself changes, not when some other workspace adds a
// forbidden import. A workspace change that introduces a violation won't be
// caught until something also touches `packages/config`.

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, "..", "..", "..");

const configPackageName = ["@supabase", "config"].join("/");
const forbiddenIoSpecifier = `${configPackageName}/io`;
const forbiddenDeepImportPrefix = `${configPackageName}/src/`;

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".repos"]);
const thisPackageSrcDir = srcDir;

function collectTsFiles(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || fullPath === thisPackageSrcDir) {
        continue;
      }
      collectTsFiles(fullPath, into);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      into.push(fullPath);
    }
  }
}

function findViolations(forbiddenSpecifier: string): string[] {
  const files: string[] = [];
  for (const workspaceRoot of ["apps", "packages"]) {
    collectTsFiles(join(repoRoot, workspaceRoot), files);
  }

  return files.filter((file) => readFileSync(file, "utf8").includes(forbiddenSpecifier)).sort();
}

describe("monorepo import contract for @supabase/config", () => {
  test("no file outside this package imports the @supabase/config/io entrypoint", () => {
    expect(findViolations(forbiddenIoSpecifier)).toEqual([]);
  });

  test("no file outside this package deep-imports @supabase/config/src/*", () => {
    expect(findViolations(forbiddenDeepImportPrefix)).toEqual([]);
  });
});
