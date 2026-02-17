import { $ } from "bun";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

try {
  await $`brew --version`.quiet();
} catch {
  console.log("[brew] SKIP — brew not found");
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
  },
});

const version = values.version;
if (!version) {
  console.error("Usage: bun run smoke-test-brew.ts --version <version>");
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "../../..");

async function createTmpDir(prefix: string): Promise<AsyncDisposable & { path: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true });
    },
  };
}

// Generate the formula with local file:// URLs
console.log("Generating Homebrew formula...");
await $`bun run packages/cli-dist/scripts/update-homebrew.ts --version ${version} --local`.cwd(
  root,
);

// Create a local git-backed tap
await using tap = await createTmpDir("brew-smoke-");
await mkdir(path.join(tap.path, "Formula"));
await $`cp ${path.join(root, "dist", "supabase.rb")} ${path.join(tap.path, "Formula", "supabase.rb")}`;
await $`git -C ${tap.path} init`.quiet();
await $`git -C ${tap.path} add .`.quiet();
await $`git -C ${tap.path} commit -m init`.quiet();

console.log("Installing via Homebrew...");
await $`brew tap --force supabase/test-tap ${tap.path}`;

try {
  await $`brew install supabase/test-tap/supabase`;

  const output = await $`supabase --version`.text();
  const trimmed = output.trim();
  const passed = /^\d+\.\d+\.\d+/.test(trimmed);

  console.log(`\n${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);

  if (!passed) {
    process.exit(1);
  }
} finally {
  await $`brew uninstall supabase`.nothrow();
  await $`brew untap supabase/test-tap`.nothrow();
}
