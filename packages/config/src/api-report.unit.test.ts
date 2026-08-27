import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CLI-2234 enforcement layer 4: `packages/config/api-report/` is a checked-in
// mirror of this package's compiled `.d.ts` surface (synced by
// `scripts/build.ts`'s `syncApiReport`, via `tsconfig.api-report.json`). This
// regenerates that same declarations-only build into a temp dir with the
// exact same config and diffs it against the checked-in mirror, so a
// type-signature change anywhere in `src/` shows up as a reviewable
// `api-report/` diff instead of passing silently.

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(srcDir, "..");
const apiReportDir = join(packageRoot, "api-report");

const FAILURE_MESSAGE =
  "type surface changed — run `pnpm --filter @supabase/config build` and review+commit the api-report/ diff";

async function listDeclarationFiles(root: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.d.ts");
  const relativePaths: string[] = [];
  for await (const relativePath of glob.scan({ cwd: root })) {
    relativePaths.push(relativePath);
  }
  return relativePaths.sort();
}

/**
 * `bun --bun vitest` (this package's mandated test runner, per `AGENTS.md`)
 * prepends a synthetic `node` shim directory (`/tmp/bun-node-*`, `node` ->
 * `bun`) to `PATH` for the whole process tree, so any nested
 * `#!/usr/bin/env node` script resolves to Bun instead of real Node. `pnpm`'s
 * own launcher is exactly such a script, and its corepack wrapper needs
 * `node:sqlite`, which Bun's Node-compat layer doesn't implement — so
 * spawning `pnpm` unmodified from inside this test fails before it ever
 * reaches `tsc`. Stripping that shim directory back out restores real `node`
 * resolution for the spawned `pnpm` subprocess.
 */
function pnpmSpawnEnv(): Record<string, string | undefined> {
  const path = process.env.PATH ?? "";
  const sanitizedPath = path
    .split(":")
    .filter((segment) => !segment.includes("/bun-node-"))
    .join(":");
  return { ...process.env, PATH: sanitizedPath };
}

describe("api-report/ mirrors the compiled declaration surface", () => {
  test("a fresh declarations-only build matches the checked-in api-report/ mirror", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "supabase-config-api-report-test-"));

    try {
      const tsc = Bun.spawn(
        ["pnpm", "exec", "tsc", "-p", "tsconfig.api-report.json", "--outDir", scratchDir],
        { cwd: packageRoot, env: pnpmSpawnEnv(), stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        tsc.exited,
        new Response(tsc.stdout).text(),
        new Response(tsc.stderr).text(),
      ]);
      expect(exitCode, `tsc failed:\n${stdout}\n${stderr}`).toBe(0);

      const [freshFiles, checkedInFiles] = await Promise.all([
        listDeclarationFiles(scratchDir),
        listDeclarationFiles(apiReportDir),
      ]);

      expect(freshFiles, FAILURE_MESSAGE).toEqual(checkedInFiles);

      const mismatches: string[] = [];
      for (const relativePath of freshFiles) {
        const [fresh, checkedIn] = await Promise.all([
          readFile(join(scratchDir, relativePath), "utf8"),
          readFile(join(apiReportDir, relativePath), "utf8"),
        ]);
        if (fresh !== checkedIn) {
          mismatches.push(relativePath);
        }
      }

      expect(mismatches, FAILURE_MESSAGE).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 20_000);
});
